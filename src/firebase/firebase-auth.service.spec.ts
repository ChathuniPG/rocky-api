import { Logger } from '@nestjs/common';
import type { App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FirebaseAuthService } from './firebase-auth.service';
import {
  EmailAlreadyExistsError,
  FirebaseDomainError,
  FirebaseUnavailableError,
  InvalidEmailError,
  InvalidTokenError,
  TokenExpiredError,
  TokenRevokedError,
  UserDisabledError,
  UserNotFoundError,
  WeakPasswordError,
} from './firebase.errors';

// Stubbed Admin Auth client: unit tests never call Firebase.
const mockAuth = {
  createUser: jest.fn(),
  deleteUser: jest.fn(),
  getUserByEmail: jest.fn(),
  verifyIdToken: jest.fn(),
  revokeRefreshTokens: jest.fn(),
};

jest.mock('firebase-admin/auth', () => ({
  getAuth: jest.fn(() => mockAuth),
}));

const fakeApp: App = { name: 'rocky-api-test', options: {} };
const FAKE_ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.fake-id-token-payload.fake-signature';
const UID = 'firebase-uid-123';

/** Builds an error shaped like the SDK's FirebaseAuthError. Its message echoes a secret. */
function firebaseError(code: string): Error {
  return Object.assign(new Error(`Firebase said no for ${FAKE_ID_TOKEN}`), { code });
}

/**
 * Awaits `promise` and returns its rejection narrowed to `type`. Fails the test if the
 * promise resolves or rejects with anything else.
 */
async function rejectionOf<T extends Error>(
  promise: Promise<unknown>,
  type: abstract new (...args: never[]) => T,
): Promise<T> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof type) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the promise to reject');
}

describe('FirebaseAuthService', () => {
  let service: FirebaseAuthService;
  let errorLogSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    errorLogSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    service = new FirebaseAuthService(fakeApp);
  });

  afterEach(() => {
    errorLogSpy.mockRestore();
  });

  it('uses the Auth client of the injected app', () => {
    expect(getAuth).toHaveBeenCalledWith(fakeApp);
  });

  describe('createUser', () => {
    const input = { email: 'rocky@example.com', password: 'Str0ng-pass!', displayName: 'Rocky' };

    it('creates the user and returns only its UID', async () => {
      mockAuth.createUser.mockResolvedValue({ uid: UID, email: input.email, disabled: false });

      await expect(service.createUser(input)).resolves.toEqual({ uid: UID });
      expect(mockAuth.createUser).toHaveBeenCalledWith(input);
    });

    it.each([
      ['auth/email-already-exists', EmailAlreadyExistsError],
      ['auth/invalid-email', InvalidEmailError],
      ['auth/invalid-password', WeakPasswordError],
    ])('maps %s to %p', async (code, expected) => {
      mockAuth.createUser.mockRejectedValue(firebaseError(code));

      await expect(service.createUser(input)).rejects.toBeInstanceOf(expected);
    });
  });

  describe('deleteUser', () => {
    it('deletes the user by UID', async () => {
      mockAuth.deleteUser.mockResolvedValue(undefined);

      await service.deleteUser(UID);

      expect(mockAuth.deleteUser).toHaveBeenCalledWith(UID);
    });

    it('maps auth/user-not-found to UserNotFoundError', async () => {
      mockAuth.deleteUser.mockRejectedValue(firebaseError('auth/user-not-found'));

      await expect(service.deleteUser(UID)).rejects.toBeInstanceOf(UserNotFoundError);
    });
  });

  describe('findUserByEmail', () => {
    const email = 'demo@example.com';

    it('returns only the UID of the user with this email', async () => {
      mockAuth.getUserByEmail.mockResolvedValue({ uid: UID, email, disabled: false });

      await expect(service.findUserByEmail(email)).resolves.toEqual({ uid: UID });
      expect(mockAuth.getUserByEmail).toHaveBeenCalledWith(email);
    });

    it('returns null when no user has this email', async () => {
      mockAuth.getUserByEmail.mockRejectedValue(firebaseError('auth/user-not-found'));

      await expect(service.findUserByEmail(email)).resolves.toBeNull();
      expect(errorLogSpy).not.toHaveBeenCalled();
    });

    it('maps any other failure to FirebaseUnavailableError', async () => {
      mockAuth.getUserByEmail.mockRejectedValue(firebaseError('auth/internal-error'));

      await expect(service.findUserByEmail(email)).rejects.toBeInstanceOf(FirebaseUnavailableError);
    });
  });

  describe('verifyIdToken', () => {
    it('always checks revocation and returns the decoded token', async () => {
      const decoded = { uid: UID, email: 'rocky@example.com' };
      mockAuth.verifyIdToken.mockResolvedValue(decoded);

      await expect(service.verifyIdToken(FAKE_ID_TOKEN)).resolves.toBe(decoded);
      // Second argument is checkRevoked (design §3.5).
      expect(mockAuth.verifyIdToken).toHaveBeenCalledWith(FAKE_ID_TOKEN, true);
    });

    it.each([
      ['auth/id-token-expired', TokenExpiredError],
      ['auth/id-token-revoked', TokenRevokedError],
      ['auth/user-disabled', UserDisabledError],
      ['auth/argument-error', InvalidTokenError],
      ['auth/invalid-id-token', InvalidTokenError],
      ['auth/user-not-found', InvalidTokenError],
    ])('maps %s to %p without logging', async (code, expected) => {
      mockAuth.verifyIdToken.mockRejectedValue(firebaseError(code));

      await expect(service.verifyIdToken(FAKE_ID_TOKEN)).rejects.toBeInstanceOf(expected);
      // Expected failures (e.g. an expired cookie) are normal traffic, not server errors.
      expect(errorLogSpy).not.toHaveBeenCalled();
    });
  });

  describe('revokeRefreshTokens', () => {
    it('revokes the tokens of the user', async () => {
      mockAuth.revokeRefreshTokens.mockResolvedValue(undefined);

      await service.revokeRefreshTokens(UID);

      expect(mockAuth.revokeRefreshTokens).toHaveBeenCalledWith(UID);
    });

    it('maps auth/user-not-found to UserNotFoundError', async () => {
      mockAuth.revokeRefreshTokens.mockRejectedValue(firebaseError('auth/user-not-found'));

      await expect(service.revokeRefreshTokens(UID)).rejects.toBeInstanceOf(UserNotFoundError);
    });
  });

  describe('unexpected errors', () => {
    it('maps an unknown code to FirebaseUnavailableError and keeps the cause', async () => {
      const original = firebaseError('auth/internal-error');
      mockAuth.verifyIdToken.mockRejectedValue(original);

      const error = await rejectionOf(
        service.verifyIdToken(FAKE_ID_TOKEN),
        FirebaseUnavailableError,
      );

      expect(error.cause).toBe(original);
      expect(errorLogSpy).toHaveBeenCalledWith(
        'Firebase verifyIdToken failed with unexpected error code: auth/internal-error',
      );
    });

    it('maps an error without a code (e.g. a network failure)', async () => {
      mockAuth.revokeRefreshTokens.mockRejectedValue(new TypeError('fetch failed'));

      await expect(service.revokeRefreshTokens(UID)).rejects.toBeInstanceOf(
        FirebaseUnavailableError,
      );
      expect(errorLogSpy).toHaveBeenCalledWith(
        'Firebase revokeRefreshTokens failed with unexpected error code: none',
      );
    });

    it('does not treat Object.prototype members as known codes', async () => {
      mockAuth.deleteUser.mockRejectedValue(firebaseError('constructor'));

      await expect(service.deleteUser(UID)).rejects.toBeInstanceOf(FirebaseUnavailableError);
    });

    it('maps auth/user-not-found per operation', async () => {
      // A missing user is a lookup failure for deleteUser, but for verifyIdToken it means
      // the token belongs to a deleted account and cannot be trusted.
      mockAuth.deleteUser.mockRejectedValue(firebaseError('auth/user-not-found'));
      mockAuth.verifyIdToken.mockRejectedValue(firebaseError('auth/user-not-found'));

      await expect(service.deleteUser(UID)).rejects.toBeInstanceOf(UserNotFoundError);
      await expect(service.verifyIdToken(FAKE_ID_TOKEN)).rejects.toBeInstanceOf(InvalidTokenError);
    });
  });

  it('never exposes the token or the raw Firebase message in errors or logs', async () => {
    mockAuth.verifyIdToken.mockRejectedValue(firebaseError('auth/id-token-revoked'));
    mockAuth.revokeRefreshTokens.mockRejectedValue(firebaseError('auth/internal-error'));

    const errors = [
      await rejectionOf(service.verifyIdToken(FAKE_ID_TOKEN), FirebaseDomainError),
      await rejectionOf(service.revokeRefreshTokens(UID), FirebaseDomainError),
    ];

    for (const error of errors) {
      expect(error.message).not.toContain(FAKE_ID_TOKEN);
    }
    expect(JSON.stringify(errorLogSpy.mock.calls)).not.toContain(FAKE_ID_TOKEN);
  });

  it('domain errors expose a stable code and their class name', () => {
    const error = new TokenRevokedError();

    expect(error.code).toBe('TOKEN_REVOKED');
    expect(error.name).toBe('TokenRevokedError');
    expect(error).toBeInstanceOf(Error);
  });
});
