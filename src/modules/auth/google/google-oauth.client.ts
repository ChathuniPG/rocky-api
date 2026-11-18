import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../../../config/env.validation';

/** Google's OAuth 2.0 authorization endpoint (web server flow). */
export const GOOGLE_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

/** Google's token endpoint: exchanges an authorization code for tokens. */
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Scopes requested from Google (issue #42): identity only. They match the consent screen's
 * configuration; asking for more would show a different, scarier consent screen.
 */
export const GOOGLE_OAUTH_SCOPES = 'openid email profile';

/** Maximum time for the token exchange; Node's fetch has no overall timeout of its own. */
export const GOOGLE_TOKEN_TIMEOUT_MS = 10_000;

/** Issuers Google's documentation lists for its ID tokens. */
const GOOGLE_ISSUERS: ReadonlySet<string> = new Set([
  'https://accounts.google.com',
  'accounts.google.com',
]);

/** Shape of an OAuth error code, e.g. invalid_grant. Anything else is never logged. */
const OAUTH_ERROR_CODE_PATTERN = /^[a-z_]+$/;

/** Values that make one authorization URL unique to a sign-in attempt. */
export interface AuthorizationRequest {
  /** CSRF protection; echoed back by Google in the callback. */
  state: string;
  /** PKCE S256 challenge of the verifier kept in rocky_oauth. */
  codeChallenge: string;
}

/** The identity claims the API reads from a Google ID token. */
export interface GoogleIdTokenClaims {
  /** The account's email address (lowercased). */
  email: string;
  /** Whether Google has verified the email address. */
  emailVerified: boolean;
}

/**
 * The token exchange failed: Google rejected the code (e.g. `invalid_grant` for a reused
 * or expired code, or a PKCE mismatch), was unreachable, or sent a malformed response. The
 * message is a fixed string; nothing from the request or response is kept.
 */
export class GoogleTokenExchangeError extends Error {
  constructor() {
    super('Google token exchange failed');
    this.name = new.target.name;
  }
}

/**
 * Client for Google's OAuth 2.0 endpoints (ADR-015): builds the authorization URL and
 * exchanges the authorization code (with the PKCE verifier) for a Google ID token, using
 * Node's built-in fetch. The authorization code, tokens, verifier and client secret are
 * never logged.
 */
@Injectable()
export class GoogleOAuthClient {
  private readonly logger = new Logger(GoogleOAuthClient.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    this.clientId = config.get('GOOGLE_OAUTH_CLIENT_ID', { infer: true });
    this.clientSecret = config.get('GOOGLE_OAUTH_CLIENT_SECRET', { infer: true });
    this.redirectUri = config.get('GOOGLE_OAUTH_REDIRECT_URI', { infer: true });
  }

  /**
   * Builds the URL that starts Google's consent screen (Authorization Code flow + PKCE).
   *
   * @param request - The attempt's state and PKCE challenge.
   * @returns The absolute authorization URL to redirect the browser to.
   */
  buildAuthorizationUrl(request: AuthorizationRequest): string {
    const url = new URL(GOOGLE_AUTHORIZATION_URL);
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: GOOGLE_OAUTH_SCOPES,
      state: request.state,
      code_challenge: request.codeChallenge,
      code_challenge_method: 'S256',
      // Always show the account chooser, so a shared computer does not silently sign in
      // with whichever Google account is active in the browser.
      prompt: 'select_account',
    }).toString();
    return url.toString();
  }

  /**
   * Exchanges an authorization code for a Google ID token.
   *
   * @param code - The `code` query parameter of the callback.
   * @param codeVerifier - The PKCE verifier stored when the sign-in started.
   * @returns The Google ID token (a JWT).
   * @throws {GoogleTokenExchangeError} If Google rejects the request, cannot be reached,
   *   times out, or returns a response without an ID token.
   */
  async exchangeCode(code: string, codeVerifier: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: this.clientId,
          client_secret: this.clientSecret,
          redirect_uri: this.redirectUri,
          grant_type: 'authorization_code',
          code_verifier: codeVerifier,
        }).toString(),
        signal: AbortSignal.timeout(GOOGLE_TOKEN_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      this.logger.warn(`Google token exchange request failed: ${describeFetchFailure(error)}`);
      throw new GoogleTokenExchangeError();
    }

    const payload = await readJson(response);
    if (!response.ok) {
      this.logger.warn(
        `Google token exchange failed: HTTP ${response.status} ${readOAuthErrorCode(payload)}`,
      );
      throw new GoogleTokenExchangeError();
    }

    const idToken = isRecord(payload) ? payload.id_token : undefined;
    if (typeof idToken !== 'string' || idToken.length === 0) {
      this.logger.warn('Google token exchange returned no id_token');
      throw new GoogleTokenExchangeError();
    }
    return idToken;
  }

  /**
   * Reads the email claims of a Google ID token returned by {@link exchangeCode}.
   *
   * The signature is not checked here: Google's OpenID Connect documentation says a token
   * received directly from its token endpoint over TLS, authenticated with the client
   * secret, can be trusted. Firebase signInWithIdp verifies the signature again before it
   * signs anyone in. The audience and issuer are still checked, as cheap defence in depth.
   *
   * @param idToken - The Google ID token.
   * @returns The email claims, or `undefined` if the token is malformed, was issued for
   *   another client or by another issuer, or has no email.
   */
  readIdTokenClaims(idToken: string): GoogleIdTokenClaims | undefined {
    const claims = decodeJwtPayload(idToken);
    if (!claims) {
      return undefined;
    }
    const { aud, iss, email, email_verified: emailVerified } = claims;
    if (aud !== this.clientId || typeof iss !== 'string' || !GOOGLE_ISSUERS.has(iss)) {
      return undefined;
    }
    if (typeof email !== 'string' || email.length === 0) {
      return undefined;
    }
    return { email: email.toLowerCase(), emailVerified: emailVerified === true };
  }
}

/** Decodes the payload segment of a JWT without verifying it. */
function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
  const segments = jwt.split('.');
  if (segments.length !== 3) {
    return undefined;
  }
  try {
    const payload: unknown = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    return isRecord(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
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
 * The `error` field of an OAuth error body (`{ "error": "invalid_grant", ... }`), if it
 * looks like a code. `error_description` is free text and is never read.
 */
function readOAuthErrorCode(payload: unknown): string {
  const code = isRecord(payload) ? payload.error : undefined;
  return typeof code === 'string' && OAUTH_ERROR_CODE_PATTERN.test(code) ? code : 'no error code';
}

/** A log-safe description of a fetch failure: no URL, headers or body. */
function describeFetchFailure(error: unknown): string {
  // See FirebaseAuthRestClient: the name is checked because DOMException can come from
  // another realm, where instanceof fails.
  if (isRecord(error) && error.name === 'TimeoutError') {
    return `timed out after ${GOOGLE_TOKEN_TIMEOUT_MS} ms`;
  }
  return 'network error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
