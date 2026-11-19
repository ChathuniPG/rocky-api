import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';
import {
  ID_TOKEN_COOKIE,
  OAUTH_COOKIE,
  OAUTH_COOKIE_MAX_AGE_MS,
  OAUTH_COOKIE_PATH,
  REFRESH_COOKIE_MAX_AGE_MS,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_COOKIE,
} from '../../common/auth/auth-cookies';
import type { EnvironmentVariables } from '../../config/env.validation';
import type { FirebaseSession } from '../../firebase/firebase-auth-rest.client';

/**
 * Writes and clears the auth cookies (design §3.2, ADR-003): the two session cookies and
 * the short-lived Google sign-in cookie (ADR-015). All are httpOnly, so page JavaScript
 * can never read them; SameSite=Lax blocks them on cross-site POSTs (CSRF) but still sends
 * them on the top-level GET redirect back from Google; Secure comes from COOKIE_SECURE.
 */
@Injectable()
export class AuthCookieService {
  private readonly secure: boolean;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    this.secure = config.get('COOKIE_SECURE', { infer: true });
  }

  /**
   * Sets rocky_id (path /, lifetime of the ID token) and rocky_refresh (auth endpoints
   * only, 30 days).
   *
   * @param response - The Express response.
   * @param session - Tokens from a Firebase sign-in or refresh.
   */
  setSessionCookies(response: Response, session: FirebaseSession): void {
    response.cookie(ID_TOKEN_COOKIE, session.idToken, {
      ...this.idCookieOptions(),
      // The cookie disappears when the token expires, so the browser never sends a
      // token that is certain to be rejected.
      maxAge: session.expiresInSeconds * 1000,
    });
    response.cookie(REFRESH_TOKEN_COOKIE, session.refreshToken, {
      ...this.refreshCookieOptions(),
      maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    });
  }

  /**
   * Clears both cookies. Browsers only delete a cookie whose path matches the one it was
   * set with, so the same options are reused.
   *
   * @param response - The Express response.
   */
  clearSessionCookies(response: Response): void {
    response.clearCookie(ID_TOKEN_COOKIE, this.idCookieOptions());
    response.clearCookie(REFRESH_TOKEN_COOKIE, this.refreshCookieOptions());
  }

  /**
   * Sets rocky_oauth for one Google sign-in attempt: sent only to /api/v1/auth/google/*,
   * and gone after 10 minutes.
   *
   * @param response - The Express response.
   * @param value - The serialised attempt state (see `serializeOAuthCookie`).
   */
  setOAuthCookie(response: Response, value: string): void {
    response.cookie(OAUTH_COOKIE, value, {
      ...this.oauthCookieOptions(),
      maxAge: OAUTH_COOKIE_MAX_AGE_MS,
    });
  }

  /**
   * Clears rocky_oauth, so a state and PKCE verifier can never be used twice.
   *
   * @param response - The Express response.
   */
  clearOAuthCookie(response: Response): void {
    response.clearCookie(OAUTH_COOKIE, this.oauthCookieOptions());
  }

  private idCookieOptions(): CookieOptions {
    return { httpOnly: true, secure: this.secure, sameSite: 'lax', path: '/' };
  }

  private refreshCookieOptions(): CookieOptions {
    return { httpOnly: true, secure: this.secure, sameSite: 'lax', path: REFRESH_COOKIE_PATH };
  }

  private oauthCookieOptions(): CookieOptions {
    return { httpOnly: true, secure: this.secure, sameSite: 'lax', path: OAUTH_COOKIE_PATH };
  }
}
