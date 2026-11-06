import type { Response } from 'supertest';

/**
 * Returns the response's Set-Cookie headers. supertest types headers loosely, so the value
 * is narrowed here.
 *
 * @param response - A supertest response.
 * @returns One string per Set-Cookie header (empty if none).
 */
export function setCookieHeaders(response: Response): string[] {
  const value: unknown = response.headers['set-cookie'];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return typeof value === 'string' ? [value] : [];
}

/**
 * Finds the Set-Cookie header for one cookie.
 *
 * @param response - A supertest response.
 * @param name - Cookie name, e.g. rocky_id.
 * @returns The full header (value and attributes), or `undefined` if not set.
 */
export function findSetCookie(response: Response, name: string): string | undefined {
  return setCookieHeaders(response).find((header) => header.startsWith(`${name}=`));
}

/**
 * Reads a cookie's value from a response's Set-Cookie headers.
 *
 * @param response - A supertest response.
 * @param name - Cookie name.
 * @returns The decoded value, or `undefined` if the cookie was not set.
 */
export function setCookieValue(response: Response, name: string): string | undefined {
  const header = findSetCookie(response, name);
  if (header === undefined) {
    return undefined;
  }
  const [pair] = header.split(';');
  return decodeURIComponent(pair.slice(name.length + 1));
}

/**
 * Builds a Cookie request header. Cookies are sent explicitly because supertest does not
 * replay Secure cookies over plain http.
 *
 * @param cookies - Name/value pairs; `undefined` values are skipped.
 * @returns The header value, e.g. "rocky_id=abc; rocky_refresh=def".
 */
export function cookieHeader(cookies: Record<string, string | undefined>): string {
  return Object.entries(cookies)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('; ');
}
