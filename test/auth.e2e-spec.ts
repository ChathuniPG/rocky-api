import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { App as FirebaseApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { FIREBASE_APP } from '../src/firebase/firebase.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { cookieHeader, findSetCookie, setCookieValue } from './helpers/cookies';

// Live test of the full auth lifecycle against the real local database and the real
// Firebase project from .env. Prerequisites: `npm run db:up`, migrations applied, and a
// configured Firebase project with email/password sign-in enabled.
//
// It creates one uniquely named user and always deletes it from Firebase and PostgreSQL
// afterwards, even if a step fails. The steps share state and run in order.

jest.setTimeout(60_000);

const suffix = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const email = `rocky-e2e-${suffix}@example.com`;
const username = `e2e_${suffix}`;
const password = `E2e-${randomBytes(6).toString('hex')}1`;

describe('Auth lifecycle (e2e, live Firebase)', () => {
  let app: INestApplication<App>;
  let idToken: string | undefined;
  let refreshToken: string | undefined;
  let idTokenBeforeLogout: string | undefined;
  let refreshTokenBeforeLogout: string | undefined;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<INestApplication<App>>());
    await app.init();
  });

  afterAll(async () => {
    await deleteTestUser(app);
    await app.close();
  });

  /** Sends GET /auth/me with the given ID token. */
  function getMe(token: string | undefined): request.Test {
    return request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', cookieHeader({ rocky_id: token }));
  }

  it('signs up and sets both cookies', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/signup')
      .send({ email: email.toUpperCase(), password, username, displayName: '  E2E User  ' })
      .expect(201);

    expect(response.body).toMatchObject({ email, username, displayName: 'E2E User' });
    expect(response.body).not.toHaveProperty('firebaseUid');
    expect(findSetCookie(response, 'rocky_id')).toMatch(/HttpOnly/);
    expect(findSetCookie(response, 'rocky_refresh')).toMatch(/Path=\/api\/v1\/auth/);

    idToken = setCookieValue(response, 'rocky_id');
    refreshToken = setCookieValue(response, 'rocky_refresh');
    expect(idToken).toBeTruthy();
    expect(refreshToken).toBeTruthy();
  });

  it('rejects a second sign-up with the same username (409)', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/signup')
      .send({ email: `other-${email}`, password, username, displayName: 'Other' })
      .expect(409);

    expect(response.body).toMatchObject({ message: 'Username is already taken' });
  });

  it('rejects a second sign-up with the same email (409)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/signup')
      .send({ email, password, username: `${username}x`, displayName: 'Other' })
      .expect(409);
  });

  it('returns the current user from GET /auth/me', async () => {
    const response = await getMe(idToken).expect(200);

    expect(response.body).toMatchObject({ email, username, notificationsEnabled: true });
    expect(response.body).not.toHaveProperty('firebaseUid');
  });

  it('returns 401 from GET /auth/me without a cookie', async () => {
    await getMe(undefined).expect(401);
  });

  it('refreshes the ID token', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookieHeader({ rocky_refresh: refreshToken }))
      .expect(204);

    const newIdToken = setCookieValue(response, 'rocky_id');
    expect(newIdToken).toBeTruthy();
    idToken = newIdToken;
    refreshToken = setCookieValue(response, 'rocky_refresh') ?? refreshToken;

    await getMe(idToken).expect(200);
  });

  it('logs out, revoking the tokens and clearing both cookies', async () => {
    // Firebase compares the token's auth_time with the revocation time in whole seconds
    // and only rejects tokens strictly older. Waiting past the sign-in's second makes
    // sure the revocation really applies to the tokens issued at sign-up.
    await sleep(1_100);
    idTokenBeforeLogout = idToken;
    refreshTokenBeforeLogout = refreshToken;

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', cookieHeader({ rocky_id: idToken, rocky_refresh: refreshToken }))
      .expect(204);

    expect(setCookieValue(response, 'rocky_id')).toBe('');
    expect(setCookieValue(response, 'rocky_refresh')).toBe('');
  });

  it('rejects the old ID token after logout (revoked, not just cleared)', async () => {
    const response = await getMe(idTokenBeforeLogout).expect(401);

    expect(response.body).toMatchObject({ statusCode: 401, error: 'Unauthorized' });
  });

  it('rejects the old refresh token after logout and clears the cookies', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookieHeader({ rocky_refresh: refreshTokenBeforeLogout }))
      .expect(401);

    expect(setCookieValue(response, 'rocky_refresh')).toBe('');
  });

  it('rejects a wrong password with the generic message', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'wrong-password-1' })
      .expect(401);

    expect(response.body).toMatchObject({ message: 'Invalid email or password' });
  });

  it('logs in again and GET /auth/me works with the new token', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    expect(response.body).toMatchObject({ email, username });
    idToken = setCookieValue(response, 'rocky_id');

    await getMe(idToken).expect(200);
  });
});

/**
 * Removes the test user from PostgreSQL and Firebase. Looks the Firebase user up by
 * email, so it also cleans up after a sign-up that failed half-way.
 */
async function deleteTestUser(app: INestApplication<App> | undefined): Promise<void> {
  if (!app) {
    return;
  }
  await app.get(PrismaService).user.deleteMany({ where: { email } });

  const auth = getAuth(app.get<FirebaseApp>(FIREBASE_APP));
  try {
    const firebaseUser = await auth.getUserByEmail(email);
    await auth.deleteUser(firebaseUser.uid);
  } catch (error: unknown) {
    if (!isFirebaseUserNotFound(error)) {
      throw error;
    }
  }
}

function isFirebaseUserNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'auth/user-not-found'
  );
}
