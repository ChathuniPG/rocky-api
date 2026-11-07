import { Inject, Injectable, Logger } from '@nestjs/common';
import type { App } from 'firebase-admin/app';
import { type Auth, type DecodedIdToken, getAuth } from 'firebase-admin/auth';
import { type ErrorCodeMapping, readErrorCode, toDomainError } from './firebase-error.utils';
import { FIREBASE_APP } from './firebase.constants';
import {
  EmailAlreadyExistsError,
  InvalidEmailError,
  InvalidTokenError,
  TokenExpiredError,
  TokenRevokedError,
  UserDisabledError,
  UserNotFoundError,
  WeakPasswordError,
} from './firebase.errors';

export type { DecodedIdToken } from 'firebase-admin/auth';

/** Input for {@link FirebaseAuthService.createUser}. */
export interface CreateFirebaseUserInput {
  email: string;
  password: string;
  displayName: string;
}

/** The Firebase user created by {@link FirebaseAuthService.createUser}. */
export interface CreatedFirebaseUser {
  uid: string;
}

// Expected Admin SDK error codes per operation. Anything else becomes
// FirebaseUnavailableError (see toDomainError).
const CREATE_USER_ERRORS: ErrorCodeMapping = {
  'auth/email-already-exists': () => new EmailAlreadyExistsError(),
  'auth/invalid-email': () => new InvalidEmailError(),
  'auth/invalid-password': () => new WeakPasswordError(),
};

const USER_LOOKUP_ERRORS: ErrorCodeMapping = {
  'auth/user-not-found': () => new UserNotFoundError(),
};

const VERIFY_ID_TOKEN_ERRORS: ErrorCodeMapping = {
  'auth/id-token-expired': () => new TokenExpiredError(),
  'auth/id-token-revoked': () => new TokenRevokedError(),
  'auth/user-disabled': () => new UserDisabledError(),
  // Malformed token, bad signature, wrong project, or a token whose user was deleted:
  // all mean "this token cannot be trusted".
  'auth/argument-error': () => new InvalidTokenError(),
  'auth/invalid-id-token': () => new InvalidTokenError(),
  'auth/user-not-found': () => new InvalidTokenError(),
};

/**
 * Wraps the Firebase Admin Auth API (ADR-002): user creation and deletion, ID token
 * verification and refresh-token revocation. Every Firebase error is translated into a
 * `FirebaseDomainError`; this service never throws HTTP exceptions.
 */
@Injectable()
export class FirebaseAuthService {
  private readonly logger = new Logger(FirebaseAuthService.name);
  private readonly auth: Auth;

  constructor(@Inject(FIREBASE_APP) app: App) {
    this.auth = getAuth(app);
  }

  /**
   * Creates a Firebase email/password user (design §3.3, step 3).
   *
   * @param input - Email, password and display name of the new user.
   * @returns The new user's Firebase UID.
   * @throws {EmailAlreadyExistsError} If the email is already registered.
   * @throws {InvalidEmailError} If Firebase rejects the email address.
   * @throws {WeakPasswordError} If Firebase rejects the password.
   * @throws {FirebaseUnavailableError} On any other failure.
   */
  async createUser(input: CreateFirebaseUserInput): Promise<CreatedFirebaseUser> {
    try {
      const user = await this.auth.createUser({
        email: input.email,
        password: input.password,
        displayName: input.displayName,
      });
      return { uid: user.uid };
    } catch (error: unknown) {
      throw toDomainError(
        readErrorCode(error),
        error,
        CREATE_USER_ERRORS,
        'createUser',
        this.logger,
      );
    }
  }

  /**
   * Deletes a Firebase user. Also used as the compensating action when sign-up fails
   * after the Firebase user was created (design §3.3, step 5).
   *
   * @param uid - Firebase UID of the user to delete.
   * @throws {UserNotFoundError} If no user has this UID.
   * @throws {FirebaseUnavailableError} On any other failure.
   */
  async deleteUser(uid: string): Promise<void> {
    try {
      await this.auth.deleteUser(uid);
    } catch (error: unknown) {
      throw toDomainError(
        readErrorCode(error),
        error,
        USER_LOOKUP_ERRORS,
        'deleteUser',
        this.logger,
      );
    }
  }

  /**
   * Looks up a Firebase user by email address. Used by maintenance scripts (the demo
   * seed) to find accounts that have no users row, e.g. after an interrupted run.
   *
   * @param email - The email address, as stored by sign-up (trimmed, lowercase).
   * @returns The user's UID, or `null` if no user has this email.
   * @throws {FirebaseUnavailableError} On any failure other than not-found.
   */
  async findUserByEmail(email: string): Promise<CreatedFirebaseUser | null> {
    try {
      const user = await this.auth.getUserByEmail(email);
      return { uid: user.uid };
    } catch (error: unknown) {
      const code = readErrorCode(error);
      if (code === 'auth/user-not-found') {
        return null;
      }
      throw toDomainError(code, error, {}, 'getUserByEmail', this.logger);
    }
  }

  /**
   * Verifies a Firebase ID token's signature, expiry and audience, and always checks
   * whether it was revoked or the user disabled (`checkRevoked: true`, design §3.5).
   * The revocation check costs one extra Firebase call per request; it is what makes
   * logout take effect immediately instead of when the ID token expires.
   *
   * @param idToken - The raw ID token from the rocky_id cookie.
   * @returns The decoded token claims (`uid`, `email`, ...).
   * @throws {TokenExpiredError} If the token has expired.
   * @throws {TokenRevokedError} If the user's tokens were revoked after it was issued.
   * @throws {UserDisabledError} If the user account is disabled.
   * @throws {InvalidTokenError} If the token is malformed, forged or for another project.
   * @throws {FirebaseUnavailableError} On any other failure.
   */
  async verifyIdToken(idToken: string): Promise<DecodedIdToken> {
    try {
      return await this.auth.verifyIdToken(idToken, true);
    } catch (error: unknown) {
      throw toDomainError(
        readErrorCode(error),
        error,
        VERIFY_ID_TOKEN_ERRORS,
        'verifyIdToken',
        this.logger,
      );
    }
  }

  /**
   * Revokes all refresh tokens of a user (logout, design §3.6). ID tokens issued before
   * this call are rejected by {@link verifyIdToken} from now on.
   *
   * @param uid - Firebase UID of the user.
   * @throws {UserNotFoundError} If no user has this UID.
   * @throws {FirebaseUnavailableError} On any other failure.
   */
  async revokeRefreshTokens(uid: string): Promise<void> {
    try {
      await this.auth.revokeRefreshTokens(uid);
    } catch (error: unknown) {
      throw toDomainError(
        readErrorCode(error),
        error,
        USER_LOOKUP_ERRORS,
        'revokeRefreshTokens',
        this.logger,
      );
    }
  }
}
