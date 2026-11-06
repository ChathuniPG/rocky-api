/**
 * Live smoke test of the Firebase module against the real Firebase project in .env.
 *
 *   npm run firebase:smoke
 *
 * Boots only ConfigModule and FirebaseModule, so it exercises the real startup validation
 * (env variables + service account file) and the real services. It creates a uniquely
 * named throwaway user, runs the full token lifecycle (sign in, verify, refresh, revoke,
 * confirm rejection) and always deletes the user afterwards, even when a step fails.
 *
 * Output shows step names, timings, the test user's UID and error class names only:
 * never tokens, the password or the API key (NFR-SEC-04).
 *
 * Prerequisites: .env contains the FIREBASE_* variables, the key file exists, and the
 * Email/Password sign-in provider is enabled in the Firebase console.
 */
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { validateEnv } from '../../src/config/env.validation';
import { FirebaseAuthRestClient } from '../../src/firebase/firebase-auth-rest.client';
import { FirebaseAuthService } from '../../src/firebase/firebase-auth.service';
import {
  FirebaseDomainError,
  TokenExpiredError,
  TokenRevokedError,
} from '../../src/firebase/firebase.errors';
import { FirebaseModule } from '../../src/firebase/firebase.module';

/**
 * Revocation is recorded with one-second precision and compared to the token's
 * auth_time, so revoking in the same second as the sign-in would leave the token valid.
 */
const WAIT_BEFORE_REVOKE_MS = 1500;

/** Only configuration and Firebase: no database, no HTTP server. */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    FirebaseModule,
  ],
})
class SmokeTestModule {}

const logger = new Logger('FirebaseSmokeTest');

/** Runs one named step, logging ✔ or ✘ with its duration. Rethrows on failure. */
async function step<T>(name: string, action: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await action();
    logger.log(`✔ ${name} (${Math.round(performance.now() - startedAt)} ms)`);
    return result;
  } catch (error: unknown) {
    logger.error(`✘ ${name} (${Math.round(performance.now() - startedAt)} ms): ${describe(error)}`);
    throw error;
  }
}

/** Resolves if `promise` rejects with `expected`; fails the step otherwise. */
async function expectRejection(
  promise: Promise<unknown>,
  expected: abstract new (...args: never[]) => FirebaseDomainError,
): Promise<void> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof expected) {
      return;
    }
    throw new Error(`expected ${expected.name} but got ${describe(error)}`, { cause: error });
  }
  throw new Error(`expected ${expected.name} but the call succeeded`);
}

function expectEqual(actual: string, expected: string, what: string): void {
  if (actual !== expected) {
    throw new Error(`${what} does not match the created user`);
  }
}

/**
 * Log-safe description of an error. Domain error messages are fixed strings; for other
 * errors only the class name is shown, because third-party messages may echo secrets.
 */
function describe(error: unknown): string {
  if (error instanceof FirebaseDomainError) {
    return `${error.name}: ${error.message}`;
  }
  if (error instanceof Error && error.name === 'Error') {
    // Plain Errors are thrown by this script's own checks; their messages are safe.
    return error.message;
  }
  return error instanceof Error ? error.name : 'unknown error';
}

async function runLifecycle(
  auth: FirebaseAuthService,
  rest: FirebaseAuthRestClient,
): Promise<void> {
  const email = `rocky-smoke-${Date.now()}-${randomBytes(4).toString('hex')}@example.com`;
  const password = randomBytes(24).toString('base64url');
  let uid: string | undefined;

  try {
    ({ uid } = await step('create test user', () =>
      auth.createUser({ email, password, displayName: 'ROCKY smoke test' }),
    ));
    logger.log(`  test user uid: ${uid}`);
    const createdUid = uid;

    const session = await step('sign in with password (REST)', () =>
      rest.signInWithPassword(email, password),
    );
    expectEqual(session.uid, createdUid, 'sign-in uid');
    logger.log(`  ID token lifetime: ${session.expiresInSeconds} s`);

    await step('verify ID token (checkRevoked)', async () => {
      expectEqual((await auth.verifyIdToken(session.idToken)).uid, createdUid, 'token uid');
    });

    const refreshed = await step('refresh ID token (REST)', () =>
      rest.refreshIdToken(session.refreshToken),
    );
    expectEqual(refreshed.uid, createdUid, 'refreshed uid');

    await step('verify refreshed ID token', async () => {
      expectEqual((await auth.verifyIdToken(refreshed.idToken)).uid, createdUid, 'token uid');
    });

    await sleep(WAIT_BEFORE_REVOKE_MS);
    await step('revoke refresh tokens', () => auth.revokeRefreshTokens(createdUid));

    await step('original ID token is rejected as revoked', () =>
      expectRejection(auth.verifyIdToken(session.idToken), TokenRevokedError),
    );
    await step('refreshed ID token is rejected as revoked', () =>
      expectRejection(auth.verifyIdToken(refreshed.idToken), TokenRevokedError),
    );
    await step('old refresh token can no longer be exchanged', () =>
      expectRejection(rest.refreshIdToken(refreshed.refreshToken), TokenExpiredError),
    );
  } finally {
    // Always clean up, even after a failed step, so no test users accumulate.
    if (uid !== undefined) {
      const createdUid = uid;
      await step('delete test user', () => auth.deleteUser(createdUid));
    }
  }
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(SmokeTestModule, {
    logger: ['log', 'warn', 'error'],
  });

  try {
    await runLifecycle(app.get(FirebaseAuthService), app.get(FirebaseAuthRestClient));
    logger.log('Firebase smoke test PASSED');
  } catch {
    // The failing step has already been logged by step().
    logger.error('Firebase smoke test FAILED');
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  // Startup failures (invalid env, bad key file) end up here. ServiceAccountConfigError
  // and env validation messages are designed to be safe to print.
  logger.error(
    `Smoke test could not start: ${error instanceof Error ? error.message : 'unknown error'}`,
  );
  process.exitCode = 1;
});
