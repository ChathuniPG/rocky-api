/** Where to go when a requested return path is missing or unsafe. */
export const DEFAULT_REDIRECT_PATH = '/';

/**
 * Pages a freshly signed-in user must not be sent back to: they would only bounce the
 * user again. /welcome is the Google profile-setup step (issue #42), reached explicitly.
 */
const AUTH_PATHS: ReadonlySet<string> = new Set(['/login', '/signup', '/welcome']);

/** Fixed origin used only to resolve relative paths; never sent anywhere. */
const PARSE_BASE = 'http://same.site';

// Control characters (incl. tab and newline) are stripped by URL parsers, so
// "/\t/evil.com" could become "//evil.com". Rejected outright.
// oxlint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Validates a post-login return path, such as the `returnTo` of Google sign-in. Same rules
 * as rocky-web's `getSafeRedirectPath` (design §7.1, ADR-014), so both sides agree: only
 * same-site relative paths with exactly one leading "/" are accepted, which prevents open
 * redirects such as `//evil.com` or `/\evil.com` (browsers treat both as another host).
 * Anything else, and the auth pages themselves, fall back to "/".
 *
 * @param value - The requested path, e.g. from a query parameter or cookie.
 * @returns The path itself if it is safe, otherwise {@link DEFAULT_REDIRECT_PATH}.
 */
export function getSafeRedirectPath(value: string | null | undefined): string {
  if (!value) {
    return DEFAULT_REDIRECT_PATH;
  }
  if (!value.startsWith('/') || value.startsWith('//')) {
    return DEFAULT_REDIRECT_PATH;
  }
  if (value.includes('\\') || CONTROL_CHARACTERS.test(value)) {
    return DEFAULT_REDIRECT_PATH;
  }

  // Final check with the real parser: the result must stay on our origin.
  let url: URL;
  try {
    url = new URL(value, PARSE_BASE);
  } catch {
    return DEFAULT_REDIRECT_PATH;
  }
  if (url.origin !== PARSE_BASE || AUTH_PATHS.has(url.pathname)) {
    return DEFAULT_REDIRECT_PATH;
  }

  return value;
}
