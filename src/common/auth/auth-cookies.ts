import type { Request } from 'express';
import { API_PREFIX } from '../../app.setup';

/** Cookie holding the Firebase ID token (design §3.2). Sent with every API request. */
export const ID_TOKEN_COOKIE = 'rocky_id';

/** Cookie holding the Firebase refresh token (design §3.2). */
export const REFRESH_TOKEN_COOKIE = 'rocky_refresh';

/**
 * Path of the refresh cookie. Design §3.2: the long-lived refresh token is only sent to
 * the auth endpoints (refresh, logout), never to the rest of the API, which keeps it out
 * of most request logs and limits its exposure.
 */
export const REFRESH_COOKIE_PATH = `/${API_PREFIX}/auth`;

/** Lifetime of the refresh cookie: 30 days, in milliseconds. */
export const REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Reads one cookie parsed by cookie-parser.
 *
 * @param request - The Express request.
 * @param name - The cookie name.
 * @returns The cookie value, or `undefined` if it is missing, empty or not a string.
 */
export function readCookie(request: Request, name: string): string | undefined {
  // cookie-parser types cookies as `any`, and they are undefined if the middleware did not
  // run, so the value is narrowed here instead of being trusted.
  const cookies = request.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
