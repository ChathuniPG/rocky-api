import { Injectable, Logger } from '@nestjs/common';
import { getSafeRedirectPath } from '../../../common/http/safe-redirect';
import {
  FirebaseAuthRestClient,
  type FirebaseSession,
} from '../../../firebase/firebase-auth-rest.client';
import { FirebaseAuthService } from '../../../firebase/firebase-auth.service';
import { EmailAlreadyExistsError, FirebaseDomainError } from '../../../firebase/firebase.errors';
import { PrismaService } from '../../../prisma/prisma.service';
import { GoogleOAuthClient, GoogleTokenExchangeError } from './google-oauth.client';
import { parseOAuthCookie, serializeOAuthCookie } from './oauth-cookie';
import { generatePkcePair, generateState, statesMatch } from './pkce';

/** Where every failed Google sign-in ends (issue #42). rocky-web shows a generic error. */
export const GOOGLE_SIGN_IN_FAILED_PATH = '/login?error=google';

/**
 * Where a Google sign-in ends when the email already belongs to a password account
 * (ADR-015). rocky-web tells the user to log in with their password instead.
 */
export const GOOGLE_ACCOUNT_EXISTS_PATH = '/login?error=google_account_exists';

/** Profile-setup page of rocky-web for a Google user without a users row. */
export const WELCOME_PATH = '/welcome';

// Upper bounds for the callback's query values. Google's codes are a few hundred
// characters and the state is ours (43), so anything longer is not from Google.
const MAX_CODE_LENGTH = 2048;
const MAX_STATE_LENGTH = 128;
const MAX_ERROR_LENGTH = 256;

/** Shape of an OAuth error code such as access_denied; anything else is not logged. */
const OAUTH_ERROR_CODE_PATTERN = /^[a-z_]+$/;

/** Firebase provider ID of email/password accounts. */
const PASSWORD_PROVIDER = 'password';

/** Firebase provider ID of Google accounts. */
const GOOGLE_PROVIDER = 'google.com';

/** What GET /auth/google needs to start a sign-in attempt. */
export interface GoogleSignInStart {
  /** Google's consent-screen URL to redirect the browser to. */
  authorizationUrl: string;
  /** Value of the rocky_oauth cookie: state, PKCE verifier and returnTo. */
  oauthCookie: string;
}

/**
 * The raw query values of the callback. Typed as `unknown`: they come straight from the
 * URL, and Express turns a repeated parameter into an array.
 */
export interface GoogleCallbackQuery {
  code: unknown;
  state: unknown;
  error: unknown;
}

/** How the callback ends: always a redirect, with a session only on success. */
export interface GoogleCallbackOutcome {
  /** Same-site path to redirect the browser to. */
  redirectPath: string;
  /** Tokens for the session cookies; set only when the user signed in. */
  session?: FirebaseSession;
}

/** An expected reason for a failed sign-in; logged, never shown to the user. */
type FailureReason =
  | 'missing_or_invalid_cookie'
  | 'provider_error'
  | 'invalid_callback_parameters'
  | 'state_mismatch'
  | 'token_exchange_failed'
  | 'invalid_google_id_token'
  | 'email_not_verified'
  | 'password_account_exists'
  | 'need_confirmation'
  | 'firebase_sign_in_failed';

/**
 * Google sign-in (issue #42, ADR-015): the backend runs the OAuth Authorization Code flow
 * with PKCE, exchanges the code with Google, signs the user in to Firebase with the Google
 * ID token, and hands the controller a session and a redirect. Like a Spring Security
 * `OAuth2LoginAuthenticationFilter`, but explicit and without a server-side session store:
 * the attempt's state lives in the short-lived rocky_oauth cookie.
 */
@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);

  constructor(
    private readonly google: GoogleOAuthClient,
    private readonly firebaseAuth: FirebaseAuthService,
    private readonly firebaseRest: FirebaseAuthRestClient,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Starts a sign-in attempt: generates the state and PKCE pair and builds Google's
   * authorization URL.
   *
   * @param returnTo - Path to return to after sign-in; an unsafe value becomes "/".
   * @returns The authorization URL and the rocky_oauth cookie value.
   */
  startSignIn(returnTo: string | undefined): GoogleSignInStart {
    const state = generateState();
    const { codeVerifier, codeChallenge } = generatePkcePair();

    return {
      authorizationUrl: this.google.buildAuthorizationUrl({ state, codeChallenge }),
      oauthCookie: serializeOAuthCookie({
        state,
        codeVerifier,
        returnTo: getSafeRedirectPath(returnTo),
      }),
    };
  }

  /**
   * Completes a sign-in attempt from Google's callback. Every expected failure ends in a
   * redirect to the login page instead of an exception, because this route is a browser
   * navigation that must never show JSON.
   *
   * Steps: check the cookie and the state, exchange the code (with the PKCE verifier),
   * refuse emails that belong to a password-only account, sign in to Firebase, then send
   * existing users to returnTo and new users to /welcome.
   *
   * @param query - The callback's raw `code`, `state` and `error` query values.
   * @param oauthCookie - The rocky_oauth cookie value, if present.
   * @returns The redirect, plus the session when the user signed in.
   * @throws {Error} Only on unexpected failures (e.g. the database is down); the
   *   callback's exception filter turns those into the generic failure redirect.
   */
  async completeSignIn(
    query: GoogleCallbackQuery,
    oauthCookie: string | undefined,
  ): Promise<GoogleCallbackOutcome> {
    const attempt = parseOAuthCookie(oauthCookie);
    if (!attempt) {
      return this.fail('missing_or_invalid_cookie');
    }

    // Google reports a cancelled consent screen (access_denied) or any other problem as
    // ?error=...; the code value is logged only if it looks like an OAuth code.
    if (query.error !== undefined) {
      return this.fail('provider_error', oauthErrorDetail(query.error));
    }

    const code = boundedString(query.code, MAX_CODE_LENGTH);
    const state = boundedString(query.state, MAX_STATE_LENGTH);
    if (code === undefined || state === undefined) {
      return this.fail('invalid_callback_parameters');
    }

    // CSRF / login-CSRF protection: the callback must belong to the attempt this browser
    // started (ADR-015).
    if (!statesMatch(state, attempt.state)) {
      return this.fail('state_mismatch');
    }

    let googleIdToken: string;
    try {
      googleIdToken = await this.google.exchangeCode(code, attempt.codeVerifier);
    } catch (error: unknown) {
      if (error instanceof GoogleTokenExchangeError) {
        return this.fail('token_exchange_failed');
      }
      throw error;
    }

    const claims = this.google.readIdTokenClaims(googleIdToken);
    if (!claims) {
      return this.fail('invalid_google_id_token');
    }
    if (!claims.emailVerified) {
      return this.fail('email_not_verified');
    }

    // ADR-015: Firebase may replace an unverified password with the Google provider for
    // the same email. R.O.C.K.Y. never verifies emails, so a password-only account is
    // left alone and its owner keeps logging in with the password.
    if (await this.isPasswordOnlyAccount(claims.email)) {
      return this.fail('password_account_exists', undefined, GOOGLE_ACCOUNT_EXISTS_PATH);
    }

    return this.signInToFirebase(googleIdToken, attempt.returnTo);
  }

  private async isPasswordOnlyAccount(email: string): Promise<boolean> {
    const providers = await this.firebaseAuth.findSignInProviders(email);
    return (
      providers !== null &&
      providers.includes(PASSWORD_PROVIDER) &&
      !providers.includes(GOOGLE_PROVIDER)
    );
  }

  private async signInToFirebase(
    googleIdToken: string,
    returnTo: string,
  ): Promise<GoogleCallbackOutcome> {
    let session: FirebaseSession;
    try {
      const result = await this.firebaseRest.signInWithGoogleIdToken(googleIdToken);
      if (result.needConfirmation) {
        return this.fail('need_confirmation', undefined, GOOGLE_ACCOUNT_EXISTS_PATH);
      }
      session = result.session;
    } catch (error: unknown) {
      if (error instanceof EmailAlreadyExistsError) {
        return this.fail('need_confirmation', error.code, GOOGLE_ACCOUNT_EXISTS_PATH);
      }
      if (error instanceof FirebaseDomainError) {
        return this.fail('firebase_sign_in_failed', error.code);
      }
      throw error;
    }

    const profile = await this.prisma.user.findUnique({
      where: { firebaseUid: session.uid },
      select: { id: true },
    });

    // A Google user without a users row chooses a username first (issue #42). Abandoning
    // that step is harmless: the next Google sign-in lands here again.
    const redirectPath = profile
      ? returnTo
      : `${WELCOME_PATH}?returnTo=${encodeURIComponent(returnTo)}`;
    return { redirectPath, session };
  }

  /** Logs an expected failure by reason (never tokens or codes) and builds its redirect. */
  private fail(
    reason: FailureReason,
    detail?: string,
    redirectPath = GOOGLE_SIGN_IN_FAILED_PATH,
  ): GoogleCallbackOutcome {
    this.logger.warn(`Google sign-in failed: ${reason}${detail ? ` (${detail})` : ''}`);
    return { redirectPath };
  }
}

/** The value if it is a non-empty string within `maxLength`, otherwise `undefined`. */
function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

/** The OAuth error code for the log, if it looks like one, e.g. "access_denied". */
function oauthErrorDetail(value: unknown): string | undefined {
  const error = boundedString(value, MAX_ERROR_LENGTH);
  return error !== undefined && OAUTH_ERROR_CODE_PATTERN.test(error) ? error : undefined;
}
