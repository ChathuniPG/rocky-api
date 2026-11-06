import type { NestExpressApplication } from '@nestjs/platform-express';
import type { App as FirebaseApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { FIREBASE_APP } from '../../src/firebase/firebase.constants';
import { PrismaService } from '../../src/prisma/prisma.service';
import { setCookieValue } from './cookies';

/** Credentials of a uniquely named e2e test user. */
export interface TestUserCredentials {
  email: string;
  username: string;
  password: string;
}

/** A signed-up e2e test user and its session cookie value. */
export interface SignedUpTestUser extends TestUserCredentials {
  /** Internal (PostgreSQL) user ID. */
  id: string;
  /** Value of the rocky_id cookie. */
  idToken: string;
}

/**
 * Generates unique credentials, so parallel or repeated runs never collide.
 *
 * @param prefix - Short tag for the suite, kept in the email for easier manual cleanup.
 * @returns Email, username and a password that meets the sign-up rules.
 */
export function uniqueTestUserCredentials(prefix: string): TestUserCredentials {
  const suffix = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  return {
    email: `rocky-${prefix}-${suffix}@example.com`,
    username: `e2e_${suffix}`,
    password: `E2e-${randomBytes(6).toString('hex')}1`,
  };
}

/**
 * Signs up a new user through POST /auth/signup on the live Firebase project.
 *
 * @param app - The running test application.
 * @param credentials - From {@link uniqueTestUserCredentials}.
 * @returns The user's ID and ID-token cookie value.
 * @throws {Error} If sign-up does not return 201 with a rocky_id cookie.
 */
export async function signUpTestUser(
  app: NestExpressApplication,
  credentials: TestUserCredentials,
): Promise<SignedUpTestUser> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/auth/signup')
    .send({ ...credentials, displayName: 'E2E User' })
    .expect(201);

  const idToken = setCookieValue(response, 'rocky_id');
  const body: unknown = response.body;
  if (!idToken || typeof body !== 'object' || body === null || !('id' in body)) {
    throw new Error('Sign-up did not return a user and a rocky_id cookie');
  }
  return { ...credentials, id: String(body.id), idToken };
}

/**
 * Removes a test user from PostgreSQL and Firebase. Looks the Firebase user up by email,
 * so it also cleans up after a sign-up that failed half-way.
 *
 * @param app - The test application, or `undefined` if it never started.
 * @param email - The test user's email.
 */
export async function deleteTestUser(
  app: NestExpressApplication | undefined,
  email: string,
): Promise<void> {
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
