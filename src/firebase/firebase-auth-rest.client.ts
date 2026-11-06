import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation';
import { type ErrorCodeMapping, toDomainError } from './firebase-error.utils';
import {
  FirebaseUnavailableError,
  InvalidCredentialsError,
  InvalidTokenError,
  TokenExpiredError,
  TooManyAttemptsError,
  UserDisabledError,
} from './firebase.errors';

/**
 * Maximum time for one Firebase Auth REST call. Node's fetch has no overall timeout of
 * its own, so without this a stalled connection would hold the login request open
 * indefinitely.
 */
export const FIREBASE_REST_TIMEOUT_MS = 10_000;

/** Identity Toolkit: email/password sign-in (design §3.4). */
export const SIGN_IN_WITH_PASSWORD_URL =
  'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';

/** Secure Token API: exchanges a refresh token for a new ID token (design §3.6). */
export const REFRESH_TOKEN_URL = 'https://securetoken.googleapis.com/v1/token';

/** Tokens returned by a successful sign-in or refresh. */
export interface FirebaseSession {
  /** Firebase UID of the signed-in user. */
  uid: string;
  /** Firebase ID token (a JWT), sent to the browser in the rocky_id cookie. */
  idToken: string;
  /** Long-lived refresh token, sent to the browser in the rocky_refresh cookie. */
  refreshToken: string;
  /** Lifetime of `idToken` in seconds (normally 3600). */
  expiresInSeconds: number;
}

const SIGN_IN_ERRORS: ErrorCodeMapping = {
  // Design §3.4: wrong password, unknown email and malformed email all become one error,
  // so responses never reveal which emails are registered. INVALID_LOGIN_CREDENTIALS is
  // the only code returned when email enumeration protection is on (the default for new
  // projects); the other three are returned when it is off.
  INVALID_LOGIN_CREDENTIALS: () => new InvalidCredentialsError(),
  EMAIL_NOT_FOUND: () => new InvalidCredentialsError(),
  INVALID_PASSWORD: () => new InvalidCredentialsError(),
  INVALID_EMAIL: () => new InvalidCredentialsError(),
  USER_DISABLED: () => new UserDisabledError(),
  TOO_MANY_ATTEMPTS_TRY_LATER: () => new TooManyAttemptsError(),
};

const REFRESH_ERRORS: ErrorCodeMapping = {
  // Returned when the user's credential is no longer valid, e.g. after revocation or a
  // password change: the user must sign in again.
  TOKEN_EXPIRED: () => new TokenExpiredError(),
  USER_DISABLED: () => new UserDisabledError(),
  // The token is unusable: malformed, from another project, or its user was deleted.
  INVALID_REFRESH_TOKEN: () => new InvalidTokenError(),
  MISSING_REFRESH_TOKEN: () => new InvalidTokenError(),
  INVALID_GRANT_TYPE: () => new InvalidTokenError(),
  USER_NOT_FOUND: () => new InvalidTokenError(),
  TOO_MANY_ATTEMPTS_TRY_LATER: () => new TooManyAttemptsError(),
};

/** Shape of a Firebase REST error code: upper-case words, e.g. TOKEN_EXPIRED. */
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Client for the Firebase Auth REST API (ADR-002). The Admin SDK cannot check passwords,
 * so sign-in and token refresh go through these endpoints, using Node's built-in fetch.
 *
 * Every failure is translated into a `FirebaseDomainError`; this client never throws
 * HTTP exceptions. Tokens, passwords and the API key are never logged.
 */
@Injectable()
export class FirebaseAuthRestClient {
  private readonly logger = new Logger(FirebaseAuthRestClient.name);
  private readonly apiKey: string;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    this.apiKey = config.get('FIREBASE_WEB_API_KEY', { infer: true });
  }

  /**
   * Signs a user in with email and password (design §3.4).
   *
   * @param email - The user's email address.
   * @param password - The user's password.
   * @returns The new session tokens.
   * @throws {InvalidCredentialsError} If the email or password is wrong, or no such user exists.
   * @throws {UserDisabledError} If the account is disabled.
   * @throws {TooManyAttemptsError} If Firebase is throttling sign-in attempts.
   * @throws {FirebaseUnavailableError} On a timeout, network error, unexpected error
   *   code or malformed response.
   */
  async signInWithPassword(email: string, password: string): Promise<FirebaseSession> {
    const payload = await this.post({
      operation: 'signInWithPassword',
      url: SIGN_IN_WITH_PASSWORD_URL,
      contentType: 'application/json',
      body: JSON.stringify({ email, password, returnSecureToken: true }),
      errors: SIGN_IN_ERRORS,
    });

    // The two endpoints name the same fields differently (camelCase vs snake_case).
    return toSession(payload, {
      uid: 'localId',
      idToken: 'idToken',
      refreshToken: 'refreshToken',
      expiresIn: 'expiresIn',
    });
  }

  /**
   * Exchanges a refresh token for a new ID token and refresh token (design §3.6).
   *
   * @param refreshToken - The refresh token from the rocky_refresh cookie.
   * @returns The refreshed session tokens.
   * @throws {TokenExpiredError} If the credential is no longer valid (e.g. revoked).
   * @throws {UserDisabledError} If the account is disabled.
   * @throws {InvalidTokenError} If the refresh token is malformed or its user was deleted.
   * @throws {TooManyAttemptsError} If Firebase is throttling requests.
   * @throws {FirebaseUnavailableError} On a timeout, network error, unexpected error
   *   code or malformed response.
   */
  async refreshIdToken(refreshToken: string): Promise<FirebaseSession> {
    const payload = await this.post({
      operation: 'refreshIdToken',
      url: REFRESH_TOKEN_URL,
      contentType: 'application/x-www-form-urlencoded',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
      errors: REFRESH_ERRORS,
    });

    return toSession(payload, {
      uid: 'user_id',
      idToken: 'id_token',
      refreshToken: 'refresh_token',
      expiresIn: 'expires_in',
    });
  }

  /**
   * Sends one POST request and returns the parsed JSON body of a 2xx response.
   * Failures become domain errors.
   */
  private async post(request: {
    operation: string;
    url: string;
    contentType: string;
    body: string;
    errors: ErrorCodeMapping;
  }): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: 'POST',
        headers: {
          'content-type': request.contentType,
          // Header rather than ?key=: the key stays out of URLs, which proxies, error
          // messages and logs are likely to record (Google's recommended method).
          'x-goog-api-key': this.apiKey,
        },
        body: request.body,
        signal: AbortSignal.timeout(FIREBASE_REST_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      this.logger.error(
        `Firebase ${request.operation} request failed: ${describeFetchFailure(error)}`,
      );
      throw new FirebaseUnavailableError({ cause: error });
    }

    const payload = await readJson(response);
    if (response.ok) {
      return payload;
    }

    throw toDomainError(
      readRestErrorCode(payload),
      // Only the status: the response body is never kept, so nothing user-supplied can
      // reach the logs through `cause`.
      new Error(`HTTP ${response.status}`),
      request.errors,
      request.operation,
      this.logger,
    );
  }
}

/** Maps a REST response's field names to the normalised session fields. */
interface SessionFieldNames {
  uid: string;
  idToken: string;
  refreshToken: string;
  expiresIn: string;
}

/**
 * Validates a successful response body and normalises it.
 *
 * @throws {FirebaseUnavailableError} If a field is missing or has the wrong type.
 */
function toSession(payload: unknown, fields: SessionFieldNames): FirebaseSession {
  if (!isRecord(payload)) {
    throw malformedResponse();
  }

  const uid = payload[fields.uid];
  const idToken = payload[fields.idToken];
  const refreshToken = payload[fields.refreshToken];
  // Firebase returns the lifetime as a string, e.g. "3600".
  const expiresInSeconds = Number(payload[fields.expiresIn]);

  if (
    !isNonEmptyString(uid) ||
    !isNonEmptyString(idToken) ||
    !isNonEmptyString(refreshToken) ||
    !Number.isInteger(expiresInSeconds) ||
    expiresInSeconds <= 0
  ) {
    throw malformedResponse();
  }

  return { uid, idToken, refreshToken, expiresInSeconds };
}

function malformedResponse(): FirebaseUnavailableError {
  return new FirebaseUnavailableError({
    cause: new Error('Malformed Firebase Auth REST response'),
  });
}

/** Parses a JSON body, returning `undefined` if it is empty or not JSON. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Extracts the error code from a REST error body: `{ "error": { "message": "CODE" } }`.
 * Some messages carry a detail suffix, e.g.
 * "TOO_MANY_ATTEMPTS_TRY_LATER : Access to this account has been temporarily disabled...",
 * so only the part before " : " is used. Anything that does not look like a code is
 * dropped, so free text can never reach the logs.
 */
function readRestErrorCode(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.error)) {
    return undefined;
  }
  const { message } = payload.error;
  if (typeof message !== 'string') {
    return undefined;
  }
  const code = message.split(' : ')[0].trim();
  return ERROR_CODE_PATTERN.test(code) ? code : undefined;
}

/** A log-safe description of a fetch failure: no URL, headers or body. */
function describeFetchFailure(error: unknown): string {
  // AbortSignal.timeout() rejects fetch with a DOMException named "TimeoutError". The
  // name is checked instead of `instanceof Error`: DOMException can come from another
  // realm (Node internals, Jest's VM context), where instanceof checks fail.
  if (isRecord(error) && error.name === 'TimeoutError') {
    return `timed out after ${FIREBASE_REST_TIMEOUT_MS} ms`;
  }
  return 'network error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
