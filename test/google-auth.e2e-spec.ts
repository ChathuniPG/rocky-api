import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { createHash, randomBytes } from 'node:crypto';
import request, { type Response as TestResponse } from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AUTH_THROTTLE } from '../src/common/throttling/throttling.constants';
import { SIGN_IN_WITH_IDP_URL } from '../src/firebase/firebase-auth-rest.client';
import { FirebaseAuthService } from '../src/firebase/firebase-auth.service';
import { InvalidTokenError } from '../src/firebase/firebase.errors';
import { GOOGLE_TOKEN_URL } from '../src/modules/auth/google/google-oauth.client';
import { USERNAME_PATTERN } from '../src/modules/users/users.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { cookieHeader, findSetCookie, setCookieValue } from './helpers/cookies';
import { uniqueTestUserCredentials } from './helpers/test-user';

// Google sign-in (issue #42) through the real AppModule and the local database
// (prerequisite: `npm run db:up`), with every outside call replaced:
// - Google's token endpoint and Firebase signInWithIdp are answered by a fetch stub, which
//   fails the test on any other URL, so no request leaves the machine;
// - the Firebase Admin SDK (token verification, provider lookup, revocation) is overridden,
//   so no Firebase account is created.
// The only data written is the users row of the profile-setup step, deleted in afterAll.

jest.setTimeout(60_000);

/** A Google account the stubs sign in as. */
interface GoogleAccount {
  uid: string;
  email: string;
  name: string;
}

/** What the stubbed outside world answers in the current test. */
interface Scenario {
  account: GoogleAccount;
  /** Sign-in providers Firebase reports for the email; `null` = no Firebase account. */
  providers: string[] | null;
  tokenEndpoint: 'ok' | 'invalid_grant';
  signInWithIdp: 'ok' | 'needConfirmation';
}

const AUTHORIZATION_CODE = 'e2e-authorization-code';

function googleAccount(): GoogleAccount {
  const { email } = uniqueTestUserCredentials('google');
  return { uid: `e2e-google-${randomBytes(6).toString('hex')}`, email, name: 'Google E2E User' };
}

const newUser = googleAccount();
const otherAccount = googleAccount();

let scenario: Scenario;
/** URLs the app fetched, in order. */
let fetchedUrls: string[] = [];
/** Firebase ID tokens issued by the signInWithIdp stub, and whose they are. */
const issuedIdTokens = new Map<string, GoogleAccount>();

const firebaseAuth = {
  verifyIdToken: jest.fn((idToken: string) => {
    const account = issuedIdTokens.get(idToken);
    if (!account) {
      return Promise.reject(new InvalidTokenError());
    }
    return Promise.resolve({ uid: account.uid, email: account.email, name: account.name });
  }),
  findSignInProviders: jest.fn(() => Promise.resolve(scenario.providers)),
  revokeRefreshTokens: jest.fn(() => Promise.resolve()),
};

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * Google's token endpoint: checks the code and the PKCE verifier against the challenge
 * the app sent to the consent screen, then returns an ID token for the scenario's account.
 */
function answerTokenRequest(body: string, expectedChallenge: string | undefined): Response {
  const params = new URLSearchParams(body);
  const verifier = params.get('code_verifier') ?? '';
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  if (
    scenario.tokenEndpoint === 'invalid_grant' ||
    params.get('code') !== AUTHORIZATION_CODE ||
    params.get('grant_type') !== 'authorization_code' ||
    challenge !== expectedChallenge
  ) {
    return jsonResponse(400, { error: 'invalid_grant' });
  }

  const idToken = [
    base64UrlJson({ alg: 'RS256', typ: 'JWT' }),
    base64UrlJson({
      iss: 'https://accounts.google.com',
      aud: params.get('client_id'),
      sub: `google-${scenario.account.uid}`,
      email: scenario.account.email,
      email_verified: true,
      name: scenario.account.name,
    }),
    'signature',
  ].join('.');
  return jsonResponse(200, { id_token: idToken, token_type: 'Bearer', expires_in: 3599 });
}

/** Firebase signInWithIdp: exchanges the Google ID token for a Firebase session. */
function answerSignInWithIdp(body: string): Response {
  const payload: unknown = JSON.parse(body);
  const postBody =
    typeof payload === 'object' &&
    payload !== null &&
    'postBody' in payload &&
    typeof payload.postBody === 'string'
      ? payload.postBody
      : '';
  const params = new URLSearchParams(postBody);
  if (params.get('providerId') !== 'google.com' || !params.get('id_token')) {
    return jsonResponse(400, { error: { message: 'INVALID_IDP_RESPONSE' } });
  }
  if (scenario.signInWithIdp === 'needConfirmation') {
    return jsonResponse(200, { needConfirmation: true, email: scenario.account.email });
  }

  const idToken = `e2e-firebase-id-token-${randomBytes(8).toString('hex')}`;
  issuedIdTokens.set(idToken, scenario.account);
  return jsonResponse(200, {
    localId: scenario.account.uid,
    email: scenario.account.email,
    idToken,
    refreshToken: `e2e-firebase-refresh-token-${randomBytes(8).toString('hex')}`,
    expiresIn: '3600',
  });
}

/** The code challenge of the most recent sign-in start, as Google would remember it. */
let lastCodeChallenge: string | undefined;

function stubFetch(): jest.SpyInstance {
  return jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      fetchedUrls.push(url);
      const body = typeof init?.body === 'string' ? init.body : '';
      if (url === GOOGLE_TOKEN_URL) {
        return Promise.resolve(answerTokenRequest(body, lastCodeChallenge));
      }
      if (url === SIGN_IN_WITH_IDP_URL) {
        return Promise.resolve(answerSignInWithIdp(body));
      }
      return Promise.reject(new Error(`Unexpected outgoing request in e2e test: ${url}`));
    });
}

async function createApp(): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(FirebaseAuthService)
    .useValue(firebaseAuth)
    .compile();
  const app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
  await app.init();
  return app;
}

/** A started sign-in: what the browser holds before it comes back from Google. */
interface StartedSignIn {
  state: string;
  oauthCookie: string;
}

/** GET /auth/google, checked, returning the state and the rocky_oauth cookie. */
async function startSignIn(
  app: NestExpressApplication,
  returnTo = '/settings',
): Promise<StartedSignIn> {
  const response = await request(app.getHttpServer())
    .get('/api/v1/auth/google')
    .query({ returnTo })
    .expect(302);

  const location = new URL(response.headers.location);
  expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(location.searchParams.get('code_challenge_method')).toBe('S256');
  lastCodeChallenge = location.searchParams.get('code_challenge') ?? undefined;

  const state = location.searchParams.get('state');
  const oauthCookie = setCookieValue(response, 'rocky_oauth');
  if (!state || !oauthCookie) {
    throw new Error('GET /auth/google did not return a state and a rocky_oauth cookie');
  }
  return { state, oauthCookie };
}

/** Google's redirect back to the callback, as the browser sends it. */
function callback(
  app: NestExpressApplication,
  query: Record<string, string>,
  oauthCookie?: string,
): Promise<TestResponse> {
  return request(app.getHttpServer())
    .get('/api/v1/auth/google/callback')
    .query(query)
    .set('Cookie', cookieHeader({ rocky_oauth: oauthCookie }))
    .expect(302);
}

/** Runs the whole browser round trip and returns the callback response. */
async function signInWithGoogle(
  app: NestExpressApplication,
  returnTo = '/settings',
): Promise<TestResponse> {
  const { state, oauthCookie } = await startSignIn(app, returnTo);
  // Google also adds scope, authuser and prompt; the callback must ignore them.
  return callback(
    app,
    { code: AUTHORIZATION_CODE, state, scope: 'email profile openid', authuser: '0' },
    oauthCookie,
  );
}

/** Asserts a failed callback: the error page, no session, rocky_oauth cleared. */
function expectFailure(response: TestResponse, location: string): void {
  expect(response.headers.location).toBe(location);
  expect(findSetCookie(response, 'rocky_id')).toBeUndefined();
  expect(findSetCookie(response, 'rocky_refresh')).toBeUndefined();
  expect(findSetCookie(response, 'rocky_oauth')).toMatch(/^rocky_oauth=;/);
}

function resetScenario(account: GoogleAccount): void {
  scenario = { account, providers: null, tokenEndpoint: 'ok', signInWithIdp: 'ok' };
  fetchedUrls = [];
}

describe('Google sign-in (e2e, Google and Firebase stubbed)', () => {
  let app: NestExpressApplication | undefined;
  let fetchSpy: jest.SpyInstance;

  beforeAll(async () => {
    fetchSpy = stubFetch();
    app = await createApp();
  });

  afterAll(async () => {
    if (app) {
      await app
        .get(PrismaService)
        .user.deleteMany({ where: { email: { in: [newUser.email, otherAccount.email] } } });
      await app.close();
    }
    fetchSpy.mockRestore();
  });

  function server(): NestExpressApplication {
    if (!app) {
      throw new Error('The test application did not start');
    }
    return app;
  }

  // The steps share state (the new user's session and profile) and run in order. Each
  // route allows AUTH_THROTTLE.limit requests per minute; this block stays below it.
  describe('a new user', () => {
    let idToken: string | undefined;

    beforeEach(() => {
      resetScenario(newUser);
    });

    it('is sent to /welcome with a session after the first Google sign-in', async () => {
      const response = await signInWithGoogle(server());

      expect(response.headers.location).toBe('/welcome?returnTo=%2Fsettings');
      expect(fetchedUrls).toEqual([GOOGLE_TOKEN_URL, SIGN_IN_WITH_IDP_URL]);
      expect(firebaseAuth.findSignInProviders).toHaveBeenCalledWith(newUser.email);
      expect(findSetCookie(response, 'rocky_id')).toMatch(/HttpOnly/);
      expect(findSetCookie(response, 'rocky_refresh')).toMatch(/Path=\/api\/v1\/auth;/);
      expect(findSetCookie(response, 'rocky_oauth')).toMatch(
        /^rocky_oauth=;.*Path=\/api\/v1\/auth\/google;/,
      );
      idToken = setCookieValue(response, 'rocky_id');
      expect(idToken).toBeTruthy();
    });

    it('gets 403 PROFILE_INCOMPLETE from protected endpoints until the profile exists', async () => {
      const response = await request(server().getHttpServer())
        .get('/api/v1/auth/me')
        .set('Cookie', cookieHeader({ rocky_id: idToken }))
        .expect(403);

      expect(response.body).toMatchObject({
        statusCode: 403,
        message: 'Profile setup required',
        code: 'PROFILE_INCOMPLETE',
      });
    });

    let suggestedUsername = '';

    it('gets a free, valid username suggestion', async () => {
      const response = await request(server().getHttpServer())
        .get('/api/v1/auth/profile-setup')
        .set('Cookie', cookieHeader({ rocky_id: idToken }))
        .expect(200);

      const expectedBase = newUser.email.split('@')[0].replaceAll('-', '').slice(0, 24);
      expect(response.body).toEqual({
        email: newUser.email,
        displayName: newUser.name,
        suggestedUsername: expectedBase,
      });
      suggestedUsername = expectedBase;
      expect(suggestedUsername).toMatch(USERNAME_PATTERN);
    });

    it('rejects a reserved username', async () => {
      await request(server().getHttpServer())
        .post('/api/v1/auth/profile-setup')
        .set('Cookie', cookieHeader({ rocky_id: idToken }))
        .send({ username: 'welcome', displayName: 'Google E2E User' })
        .expect(400);
    });

    it('creates the profile with the email from the token, once', async () => {
      const response = await request(server().getHttpServer())
        .post('/api/v1/auth/profile-setup')
        .set('Cookie', cookieHeader({ rocky_id: idToken }))
        .send({ username: suggestedUsername, displayName: '  Google User  ' })
        .expect(201);

      expect(response.body).toMatchObject({
        email: newUser.email,
        username: suggestedUsername,
        displayName: 'Google User',
      });
      expect(response.body).not.toHaveProperty('firebaseUid');

      await request(server().getHttpServer())
        .post('/api/v1/auth/profile-setup')
        .set('Cookie', cookieHeader({ rocky_id: idToken }))
        .send({ username: `${suggestedUsername}2`, displayName: 'Again' })
        .expect(409);
    });

    it('can use protected endpoints once the profile exists', async () => {
      const response = await request(server().getHttpServer())
        .get('/api/v1/auth/me')
        .set('Cookie', cookieHeader({ rocky_id: idToken }))
        .expect(200);

      expect(response.body).toMatchObject({ email: newUser.email, username: suggestedUsername });
    });

    it('goes straight to returnTo on the next Google sign-in', async () => {
      const response = await signInWithGoogle(server(), '/settings');

      expect(response.headers.location).toBe('/settings');
      expect(setCookieValue(response, 'rocky_id')).toBeTruthy();
    });

    it('signs out like any other user', async () => {
      await request(server().getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Cookie', cookieHeader({ rocky_id: idToken }))
        .expect(204);

      expect(firebaseAuth.revokeRefreshTokens).toHaveBeenCalledWith(newUser.uid);
    });
  });

  describe('failures', () => {
    beforeEach(() => {
      resetScenario(otherAccount);
    });

    it('rejects a state that does not match the cookie, without calling Google', async () => {
      const { oauthCookie } = await startSignIn(server());

      const response = await callback(
        server(),
        { code: AUTHORIZATION_CODE, state: 'forged-state' },
        oauthCookie,
      );

      expectFailure(response, '/login?error=google');
      expect(fetchedUrls).toEqual([]);
    });

    it('rejects a callback without the rocky_oauth cookie', async () => {
      const { state } = await startSignIn(server());

      const response = await callback(server(), { code: AUTHORIZATION_CODE, state });

      expectFailure(response, '/login?error=google');
      expect(fetchedUrls).toEqual([]);
    });

    it('ends on the login page when the user cancels on Google', async () => {
      const { state, oauthCookie } = await startSignIn(server());

      const response = await callback(server(), { error: 'access_denied', state }, oauthCookie);

      expectFailure(response, '/login?error=google');
      expect(fetchedUrls).toEqual([]);
    });

    it('ends on the login page when Google rejects the code', async () => {
      scenario.tokenEndpoint = 'invalid_grant';

      const response = await signInWithGoogle(server());

      expectFailure(response, '/login?error=google');
      expect(fetchedUrls).toEqual([GOOGLE_TOKEN_URL]);
    });

    it('blocks an email that has a password account, before calling Firebase', async () => {
      scenario.providers = ['password'];

      const response = await signInWithGoogle(server());

      expectFailure(response, '/login?error=google_account_exists');
      expect(fetchedUrls).toEqual([GOOGLE_TOKEN_URL]);
    });

    it('treats needConfirmation as an existing account', async () => {
      scenario.signInWithIdp = 'needConfirmation';

      const response = await signInWithGoogle(server());

      expectFailure(response, '/login?error=google_account_exists');
      expect(fetchedUrls).toEqual([GOOGLE_TOKEN_URL, SIGN_IN_WITH_IDP_URL]);
    });
  });
});

describe('Google sign-in rate limiting (e2e)', () => {
  // A separate application, so the in-memory throttler starts from zero.
  let app: NestExpressApplication | undefined;
  let fetchSpy: jest.SpyInstance;

  beforeAll(async () => {
    fetchSpy = stubFetch();
    app = await createApp();
  });

  afterAll(async () => {
    await app?.close();
    fetchSpy.mockRestore();
  });

  beforeEach(() => {
    resetScenario(otherAccount);
  });

  it('answers a throttled callback with the login redirect, not JSON', async () => {
    if (!app) {
      throw new Error('The test application did not start');
    }
    for (let i = 0; i < AUTH_THROTTLE.limit; i++) {
      await callback(app, { error: 'access_denied' });
    }
    const { state, oauthCookie } = await startSignIn(app);

    // A valid callback, but over the limit: it never reaches Google.
    const response = await callback(app, { code: AUTHORIZATION_CODE, state }, oauthCookie);

    expect(response.headers.location).toBe('/login?error=google');
    expect(response.headers['content-type'] ?? '').not.toContain('application/json');
    expect(findSetCookie(response, 'rocky_id')).toBeUndefined();
    expect(fetchedUrls).toEqual([]);
  });

  it('limits GET /auth/google to the auth limit with the standard 429', async () => {
    if (!app) {
      throw new Error('The test application did not start');
    }
    // The previous test already started one sign-in on this route.
    for (let i = 1; i < AUTH_THROTTLE.limit; i++) {
      await startSignIn(app);
    }

    const response = await request(app.getHttpServer()).get('/api/v1/auth/google').expect(429);

    expect(response.body).toMatchObject({ statusCode: 429, path: '/api/v1/auth/google' });
  });
});
