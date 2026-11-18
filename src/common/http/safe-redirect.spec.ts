import { getSafeRedirectPath } from './safe-redirect';

// The cases mirror rocky-web's safe-redirect tests, so both repositories apply the same
// rules; /welcome is the one addition (issue #42).
describe('getSafeRedirectPath', () => {
  it.each([
    '/',
    '/settings',
    '/u/alice',
    '/posts/123?tab=comments',
    '/messages/1#latest',
    '/search?q=a%2Fb',
  ])('accepts the same-site path %s', (path) => {
    expect(getSafeRedirectPath(path)).toBe(path);
  });

  it.each([null, undefined, ''])('falls back to / for %p', (value) => {
    expect(getSafeRedirectPath(value)).toBe('/');
  });

  it.each([
    'https://evil.com',
    'http://evil.com/path',
    'evil.com',
    'settings',
    'javascript:alert(1)',
    'data:text/html,hi',
    ' /settings',
  ])('rejects a value that is not a relative path: %s', (value) => {
    expect(getSafeRedirectPath(value)).toBe('/');
  });

  it.each(['//evil.com', '///evil.com', '/\\evil.com', '/\\/evil.com', '/foo\\bar'])(
    'rejects protocol-relative and backslash tricks: %s',
    (value) => {
      expect(getSafeRedirectPath(value)).toBe('/');
    },
  );

  it.each(['/\t/evil.com', '/\n/evil.com', '/\r\n/evil.com', '/\u0000'])(
    'rejects paths with control characters: %j',
    (value) => {
      expect(getSafeRedirectPath(value)).toBe('/');
    },
  );

  it('keeps percent-encoded slashes as a path, not a host', () => {
    expect(getSafeRedirectPath('/%2F%2Fevil.com')).toBe('/%2F%2Fevil.com');
  });

  it.each(['/login', '/signup', '/welcome', '/login?next=/settings', '/welcome?returnTo=/'])(
    'falls back to / for the auth page %s',
    (value) => {
      expect(getSafeRedirectPath(value)).toBe('/');
    },
  );
});
