import { getSafeRedirectPath } from '../../../common/http/safe-redirect';

/** What rocky_oauth remembers about one Google sign-in attempt (ADR-015). */
export interface OAuthCookieState {
  /** Random value Google must echo back in the callback. */
  state: string;
  /** PKCE code verifier, sent only to Google's token endpoint. */
  codeVerifier: string;
  /** Validated same-site path to return to after sign-in. */
  returnTo: string;
}

/** Upper bound for the stored values: far above the 43-character state and verifier. */
const MAX_SECRET_LENGTH = 128;

/** Upper bound for returnTo, matching the query parameter's limit. */
export const MAX_RETURN_TO_LENGTH = 2048;

/**
 * Serialises the attempt state for the cookie. JSON keeps it readable in tests; Express
 * URL-encodes the cookie value.
 *
 * @param value - The attempt state.
 * @returns The cookie value.
 */
export function serializeOAuthCookie(value: OAuthCookieState): string {
  return JSON.stringify(value);
}

/**
 * Parses rocky_oauth. The cookie is set only by this server and is httpOnly, but a client
 * can still send anything in its Cookie header, so every field is checked, and returnTo
 * passes the safe-redirect rules again.
 *
 * @param value - The raw cookie value, if present.
 * @returns The attempt state, or `undefined` if the cookie is missing or malformed.
 */
export function parseOAuthCookie(value: string | undefined): OAuthCookieState | undefined {
  if (value === undefined) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }

  const { state, codeVerifier, returnTo } = parsed;
  if (
    !isBoundedString(state, MAX_SECRET_LENGTH) ||
    !isBoundedString(codeVerifier, MAX_SECRET_LENGTH) ||
    !isBoundedString(returnTo, MAX_RETURN_TO_LENGTH)
  ) {
    return undefined;
  }

  return { state, codeVerifier, returnTo: getSafeRedirectPath(returnTo) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}
