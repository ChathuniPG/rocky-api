import { parseOAuthCookie, serializeOAuthCookie, type OAuthCookieState } from './oauth-cookie';

const VALID: OAuthCookieState = {
  state: 'state-abcdefghijklmnopqrstuvwxyz0123456789-_',
  codeVerifier: 'verifier-abcdefghijklmnopqrstuvwxyz0123456789',
  returnTo: '/settings',
};

describe('rocky_oauth cookie', () => {
  it('round-trips the attempt state', () => {
    expect(parseOAuthCookie(serializeOAuthCookie(VALID))).toEqual(VALID);
  });

  it('returns undefined without a cookie', () => {
    expect(parseOAuthCookie(undefined)).toBeUndefined();
  });

  it.each(['not json', '"a string"', 'null', '[]', '42'])(
    'returns undefined for malformed JSON or a non-object: %p',
    (raw) => {
      expect(parseOAuthCookie(raw)).toBeUndefined();
    },
  );

  it.each<[string, Record<string, unknown>]>([
    ['a missing state', { ...VALID, state: undefined }],
    ['an empty verifier', { ...VALID, codeVerifier: '' }],
    ['a numeric returnTo', { ...VALID, returnTo: 42 }],
    ['an over-long state', { ...VALID, state: 'x'.repeat(129) }],
    ['an over-long returnTo', { ...VALID, returnTo: `/${'x'.repeat(2048)}` }],
  ])('returns undefined for %s', (_label, value) => {
    expect(parseOAuthCookie(JSON.stringify(value))).toBeUndefined();
  });

  it('re-applies the safe-redirect rules to returnTo', () => {
    const raw = JSON.stringify({ ...VALID, returnTo: '//evil.com' });

    expect(parseOAuthCookie(raw)).toEqual({ ...VALID, returnTo: '/' });
  });
});
