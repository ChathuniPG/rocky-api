import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../../../config/env.validation';
import {
  GOOGLE_TOKEN_TIMEOUT_MS,
  GOOGLE_TOKEN_URL,
  GoogleOAuthClient,
  GoogleTokenExchangeError,
} from './google-oauth.client';

// All values are fake; fetch is mocked, so no request leaves the process.
const CLIENT_ID = '123456789012-abc.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-fake-client-secret';
const REDIRECT_URI = 'http://localhost:3000/api/v1/auth/google/callback';
const CODE = '4/0AfakeAuthorizationCode';
const CODE_VERIFIER = 'fake-verifier-abcdefghijklmnopqrstuvwxyz012345';

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** Builds an unsigned JWT with the given payload (the client never checks signatures). */
function fakeJwt(payload: Record<string, unknown>): string {
  return `${base64UrlJson({ alg: 'RS256' })}.${base64UrlJson(payload)}.fake-signature`;
}

const GOOGLE_CLAIMS = {
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  sub: '1234567890',
  email: 'Alice@Gmail.com',
  email_verified: true,
  name: 'Alice Example',
};
const ID_TOKEN = fakeJwt(GOOGLE_CLAIMS);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createClient(): GoogleOAuthClient {
  return new GoogleOAuthClient(
    new ConfigService<EnvironmentVariables, true>({
      GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
      GOOGLE_OAUTH_REDIRECT_URI: REDIRECT_URI,
    }),
  );
}

describe('GoogleOAuthClient', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let warnSpy: jest.SpyInstance;
  let client: GoogleOAuthClient;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    client = createClient();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** The `RequestInit` of the only fetch call. */
  function sentRequest(): RequestInit {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1];
    if (init === undefined) {
      throw new Error('fetch was called without options');
    }
    return init;
  }

  describe('buildAuthorizationUrl', () => {
    it('requests the code flow with PKCE S256, identity scopes and the state', () => {
      const url = new URL(
        client.buildAuthorizationUrl({ state: 'the-state', codeChallenge: 'the-challenge' }),
      );

      expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: 'openid email profile',
        state: 'the-state',
        code_challenge: 'the-challenge',
        code_challenge_method: 'S256',
        prompt: 'select_account',
      });
    });

    it('never puts the client secret in the URL', () => {
      const url = client.buildAuthorizationUrl({ state: 's', codeChallenge: 'c' });

      expect(url).not.toContain(CLIENT_SECRET);
    });
  });

  describe('exchangeCode', () => {
    it('posts a form-encoded authorization_code grant with the PKCE verifier', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id_token: ID_TOKEN, access_token: 'ya29' }));

      await client.exchangeCode(CODE, CODE_VERIFIER);

      expect(fetchMock.mock.calls[0][0]).toBe(GOOGLE_TOKEN_URL);
      const init = sentRequest();
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });
      if (typeof init.body !== 'string') {
        throw new Error('expected a string request body');
      }
      expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
        code: CODE,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
        code_verifier: CODE_VERIFIER,
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('returns the ID token and ignores the other fields', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          access_token: 'ya29.fake',
          expires_in: 3599,
          id_token: ID_TOKEN,
          scope: 'openid email profile',
          token_type: 'Bearer',
        }),
      );

      await expect(client.exchangeCode(CODE, CODE_VERIFIER)).resolves.toBe(ID_TOKEN);
    });

    it('fails on an error response and logs only the status and OAuth error code', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ error: 'invalid_grant', error_description: `Bad code ${CODE}` }, 400),
      );

      await expect(client.exchangeCode(CODE, CODE_VERIFIER)).rejects.toBeInstanceOf(
        GoogleTokenExchangeError,
      );
      expect(warnSpy).toHaveBeenCalledWith('Google token exchange failed: HTTP 400 invalid_grant');
    });

    it('does not log an error field that is not a code', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: `Code ${CODE} is bad` }, 400));

      await expect(client.exchangeCode(CODE, CODE_VERIFIER)).rejects.toBeInstanceOf(
        GoogleTokenExchangeError,
      );
      expect(warnSpy).toHaveBeenCalledWith('Google token exchange failed: HTTP 400 no error code');
    });

    it('fails on a network error', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      await expect(client.exchangeCode(CODE, CODE_VERIFIER)).rejects.toBeInstanceOf(
        GoogleTokenExchangeError,
      );
      expect(warnSpy).toHaveBeenCalledWith('Google token exchange request failed: network error');
    });

    it('fails on a timeout', async () => {
      fetchMock.mockRejectedValue(new DOMException('The operation timed out', 'TimeoutError'));

      await expect(client.exchangeCode(CODE, CODE_VERIFIER)).rejects.toBeInstanceOf(
        GoogleTokenExchangeError,
      );
      expect(warnSpy).toHaveBeenCalledWith(
        `Google token exchange request failed: timed out after ${GOOGLE_TOKEN_TIMEOUT_MS} ms`,
      );
    });

    it.each([
      ['not JSON', new Response('not json', { status: 200 })],
      ['without id_token', jsonResponse({ access_token: 'ya29' })],
      ['with an empty id_token', jsonResponse({ id_token: '' })],
      ['a JSON array', jsonResponse([])],
    ])('fails on a success response that is %s', async (_label, response) => {
      fetchMock.mockResolvedValue(response);

      await expect(client.exchangeCode(CODE, CODE_VERIFIER)).rejects.toBeInstanceOf(
        GoogleTokenExchangeError,
      );
    });

    it('never logs or throws the code, verifier, secret or token', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, 400));
      fetchMock.mockRejectedValueOnce(new TypeError(`failed ${CODE}`));

      const errors = await Promise.all([
        client.exchangeCode(CODE, CODE_VERIFIER).catch((error: unknown) => error),
        client.exchangeCode(CODE, CODE_VERIFIER).catch((error: unknown) => error),
      ]);

      const logged = JSON.stringify(warnSpy.mock.calls);
      for (const secret of [CODE, CODE_VERIFIER, CLIENT_SECRET, ID_TOKEN]) {
        expect(logged).not.toContain(secret);
        expect(JSON.stringify(errors.map(String))).not.toContain(secret);
      }
    });
  });

  describe('readIdTokenClaims', () => {
    it('returns the lowercased email and its verification flag', () => {
      expect(client.readIdTokenClaims(ID_TOKEN)).toEqual({
        email: 'alice@gmail.com',
        emailVerified: true,
      });
    });

    it('accepts the issuer without a scheme', () => {
      const token = fakeJwt({ ...GOOGLE_CLAIMS, iss: 'accounts.google.com' });

      expect(client.readIdTokenClaims(token)).toBeDefined();
    });

    it('reports an unverified email', () => {
      const token = fakeJwt({ ...GOOGLE_CLAIMS, email_verified: false });

      expect(client.readIdTokenClaims(token)).toEqual({
        email: 'alice@gmail.com',
        emailVerified: false,
      });
    });

    it.each<[string, string]>([
      ['another audience', fakeJwt({ ...GOOGLE_CLAIMS, aud: 'other.apps.googleusercontent.com' })],
      ['another issuer', fakeJwt({ ...GOOGLE_CLAIMS, iss: 'https://evil.example.com' })],
      ['no email', fakeJwt({ ...GOOGLE_CLAIMS, email: undefined })],
      ['a non-string email', fakeJwt({ ...GOOGLE_CLAIMS, email: 42 })],
      ['two segments', 'header.payload'],
      ['a payload that is not JSON', 'header.bm90IGpzb24.signature'],
      ['a payload that is an array', `header.${Buffer.from('[]').toString('base64url')}.sig`],
    ])('returns undefined for a token with %s', (_label, token) => {
      expect(client.readIdTokenClaims(token)).toBeUndefined();
    });
  });
});
