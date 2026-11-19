import {
  BadRequestException,
  ConflictException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { buildUser } from '../../../test/fixtures/user.fixture';
import {
  FirebaseAuthRestClient,
  type FirebaseSession,
} from '../../firebase/firebase-auth-rest.client';
import { FirebaseAuthService } from '../../firebase/firebase-auth.service';
import {
  EmailAlreadyExistsError,
  FirebaseUnavailableError,
  InvalidCredentialsError,
  InvalidTokenError,
  TokenExpiredError,
  TokenRevokedError,
  TooManyAttemptsError,
  UserDisabledError,
  UserNotFoundError,
  WeakPasswordError,
} from '../../firebase/firebase.errors';
import { Prisma } from '../../generated/prisma/client';
import type { VerifiedIdentity } from '../../common/auth/authenticated-request';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService, PROFILE_ALREADY_EXISTS, PROFILE_EMAIL_REQUIRED } from './auth.service';
import type { SignupDto } from './dto/signup.dto';

const FIREBASE_UID = 'firebase-uid-123';
const ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.fake-id-token.fake-signature';
const REFRESH_TOKEN = 'fake-refresh-token';

const signupDto: SignupDto = {
  email: 'alice@example.com',
  password: 'secret123',
  username: 'alice',
  displayName: 'Alice',
};

const session: FirebaseSession = {
  uid: FIREBASE_UID,
  idToken: ID_TOKEN,
  refreshToken: REFRESH_TOKEN,
  expiresInSeconds: 3600,
};

const user = buildUser({ firebaseUid: FIREBASE_UID });

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

// Stubbed dependencies: unit tests never touch PostgreSQL or Firebase.
const prisma = { user: { findUnique: jest.fn(), create: jest.fn(), findMany: jest.fn() } };
const firebaseAuth = {
  createUser: jest.fn(),
  deleteUser: jest.fn(),
  verifyIdToken: jest.fn(),
  revokeRefreshTokens: jest.fn(),
};
const firebaseRest = { signInWithPassword: jest.fn(), refreshIdToken: jest.fn() };

/** Configures the mocks for a sign-up that succeeds end to end. */
function mockSuccessfulSignup(): void {
  prisma.user.findUnique.mockResolvedValue(null);
  firebaseAuth.createUser.mockResolvedValue({ uid: FIREBASE_UID });
  prisma.user.create.mockResolvedValue(user);
  firebaseRest.signInWithPassword.mockResolvedValue(session);
}

/** Answers findUnique by the queried key: the uid's own row, or a username's row. */
function mockRows({ profile = false, username = false } = {}): void {
  prisma.user.findUnique.mockImplementation(
    ({ where }: { where: { firebaseUid?: string; username?: string } }) =>
      Promise.resolve(
        (where.firebaseUid === undefined ? username : profile) ? { id: 'row' } : null,
      ),
  );
}

/** findMany answers that the usernames matching `isTaken` exist. */
function mockTaken(isTaken: (name: string) => boolean = () => false): void {
  prisma.user.findMany.mockImplementation(({ where }: { where: { username: { in: string[] } } }) =>
    Promise.resolve(
      where.username.in.filter((name) => isTaken(name)).map((name) => ({ username: name })),
    ),
  );
}

describe('AuthService', () => {
  let service: AuthService;
  let errorLog: jest.SpyInstance;
  let warnLog: jest.SpyInstance;

  beforeEach(async () => {
    jest.resetAllMocks();
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warnLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: FirebaseAuthService, useValue: firebaseAuth },
        { provide: FirebaseAuthRestClient, useValue: firebaseRest },
      ],
    }).compile();
    service = moduleRef.get(AuthService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('signup', () => {
    it('creates the Firebase user and the users row, then signs in', async () => {
      mockSuccessfulSignup();

      const result = await service.signup(signupDto);

      expect(firebaseAuth.createUser).toHaveBeenCalledWith({
        email: 'alice@example.com',
        password: 'secret123',
        displayName: 'Alice',
      });
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: {
          firebaseUid: FIREBASE_UID,
          email: 'alice@example.com',
          username: 'alice',
          displayName: 'Alice',
        },
      });
      expect(firebaseRest.signInWithPassword).toHaveBeenCalledWith(
        'alice@example.com',
        'secret123',
      );
      expect(result.session).toBe(session);
      expect(result.user).toMatchObject({ id: user.id, username: 'alice' });
      expect(result.user).not.toHaveProperty('firebaseUid');
    });

    it('rejects a taken username before touching Firebase', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'someone-else' });

      await expect(service.signup(signupDto)).rejects.toThrow(
        new ConflictException('Username is already taken'),
      );
      expect(firebaseAuth.createUser).not.toHaveBeenCalled();
    });

    it('propagates EmailAlreadyExistsError from Firebase without inserting', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      firebaseAuth.createUser.mockRejectedValue(new EmailAlreadyExistsError());

      await expect(service.signup(signupDto)).rejects.toThrow(EmailAlreadyExistsError);
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(firebaseAuth.deleteUser).not.toHaveBeenCalled();
    });

    it('propagates WeakPasswordError from Firebase', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      firebaseAuth.createUser.mockRejectedValue(new WeakPasswordError());

      await expect(service.signup(signupDto)).rejects.toThrow(WeakPasswordError);
    });

    it('deletes the Firebase user when the insert fails, and rethrows the error', async () => {
      mockSuccessfulSignup();
      const dbError = new Error('connection lost');
      prisma.user.create.mockRejectedValue(dbError);

      await expect(service.signup(signupDto)).rejects.toBe(dbError);
      expect(firebaseAuth.deleteUser).toHaveBeenCalledWith(FIREBASE_UID);
      expect(firebaseRest.signInWithPassword).not.toHaveBeenCalled();
    });

    it('maps a username unique-constraint race to 409 after the compensating delete', async () => {
      mockSuccessfulSignup();
      // First lookup (availability check): free. Second (after the clash): taken.
      prisma.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'winner' });
      prisma.user.create.mockRejectedValue(uniqueViolation());

      await expect(service.signup(signupDto)).rejects.toThrow(
        new ConflictException('Username is already taken'),
      );
      expect(firebaseAuth.deleteUser).toHaveBeenCalledWith(FIREBASE_UID);
    });

    it('maps an email unique-constraint clash to EmailAlreadyExistsError', async () => {
      mockSuccessfulSignup();
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockRejectedValue(uniqueViolation());

      await expect(service.signup(signupDto)).rejects.toThrow(EmailAlreadyExistsError);
      expect(firebaseAuth.deleteUser).toHaveBeenCalledWith(FIREBASE_UID);
    });

    it('keeps the original error and logs when the compensating delete also fails', async () => {
      mockSuccessfulSignup();
      const dbError = new Error('connection lost');
      prisma.user.create.mockRejectedValue(dbError);
      firebaseAuth.deleteUser.mockRejectedValue(new FirebaseUnavailableError());

      await expect(service.signup(signupDto)).rejects.toBe(dbError);
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('Compensating delete failed'));
    });

    it('never logs the password', async () => {
      mockSuccessfulSignup();
      prisma.user.create.mockRejectedValue(new Error('connection lost'));
      firebaseAuth.deleteUser.mockRejectedValue(new FirebaseUnavailableError());

      await expect(service.signup(signupDto)).rejects.toThrow();
      expect(JSON.stringify([errorLog.mock.calls, warnLog.mock.calls])).not.toContain('secret123');
    });
  });

  describe('login', () => {
    it('signs in and returns the user and session', async () => {
      firebaseRest.signInWithPassword.mockResolvedValue(session);
      prisma.user.findUnique.mockResolvedValue(user);

      const result = await service.login({ email: 'alice@example.com', password: 'secret123' });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { firebaseUid: FIREBASE_UID } });
      expect(result.session).toBe(session);
      expect(result.user.id).toBe(user.id);
    });

    it('propagates InvalidCredentialsError (mapped to 401 by the filter)', async () => {
      firebaseRest.signInWithPassword.mockRejectedValue(new InvalidCredentialsError());

      await expect(
        service.login({ email: 'alice@example.com', password: 'wrong-password1' }),
      ).rejects.toThrow(InvalidCredentialsError);
    });

    it('answers like invalid credentials when the users row is missing', async () => {
      firebaseRest.signInWithPassword.mockResolvedValue(session);
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.login({ email: 'alice@example.com', password: 'secret123' }),
      ).rejects.toThrow(new UnauthorizedException('Invalid email or password'));
      expect(warnLog).toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    it('rejects a missing refresh cookie without calling Firebase', async () => {
      await expect(service.refresh(undefined)).rejects.toThrow(UnauthorizedException);
      expect(firebaseRest.refreshIdToken).not.toHaveBeenCalled();
    });

    it('returns the refreshed session', async () => {
      firebaseRest.refreshIdToken.mockResolvedValue(session);

      await expect(service.refresh(REFRESH_TOKEN)).resolves.toBe(session);
      expect(firebaseRest.refreshIdToken).toHaveBeenCalledWith(REFRESH_TOKEN);
    });

    it.each([
      new TokenExpiredError(),
      new TokenRevokedError(),
      new InvalidTokenError(),
      new UserDisabledError(),
      new UserNotFoundError(),
    ])('turns %p into 401 (session over)', async (error) => {
      firebaseRest.refreshIdToken.mockRejectedValue(error);

      await expect(service.refresh(REFRESH_TOKEN)).rejects.toThrow(
        new UnauthorizedException('Session expired, please log in again'),
      );
    });

    it.each([new TooManyAttemptsError(), new FirebaseUnavailableError()])(
      'keeps %p as it is (session may still be valid)',
      async (error) => {
        firebaseRest.refreshIdToken.mockRejectedValue(error);

        await expect(service.refresh(REFRESH_TOKEN)).rejects.toBe(error);
      },
    );
  });

  describe('logout', () => {
    it('revokes the user identified by a valid ID token', async () => {
      firebaseAuth.verifyIdToken.mockResolvedValue({ uid: FIREBASE_UID });

      await service.logout(ID_TOKEN, REFRESH_TOKEN);

      expect(firebaseAuth.revokeRefreshTokens).toHaveBeenCalledWith(FIREBASE_UID);
      expect(firebaseRest.refreshIdToken).not.toHaveBeenCalled();
    });

    it('falls back to the refresh token when the ID token is expired', async () => {
      firebaseAuth.verifyIdToken.mockRejectedValue(new TokenExpiredError());
      firebaseRest.refreshIdToken.mockResolvedValue(session);

      await service.logout(ID_TOKEN, REFRESH_TOKEN);

      expect(firebaseAuth.revokeRefreshTokens).toHaveBeenCalledWith(FIREBASE_UID);
    });

    it('uses the refresh token when there is no ID token', async () => {
      firebaseRest.refreshIdToken.mockResolvedValue(session);

      await service.logout(undefined, REFRESH_TOKEN);

      expect(firebaseAuth.verifyIdToken).not.toHaveBeenCalled();
      expect(firebaseAuth.revokeRefreshTokens).toHaveBeenCalledWith(FIREBASE_UID);
    });

    it('does nothing when neither cookie identifies a user', async () => {
      firebaseAuth.verifyIdToken.mockRejectedValue(new TokenRevokedError());
      firebaseRest.refreshIdToken.mockRejectedValue(new TokenExpiredError());

      await expect(service.logout(ID_TOKEN, REFRESH_TOKEN)).resolves.toBeUndefined();
      expect(firebaseAuth.revokeRefreshTokens).not.toHaveBeenCalled();
    });

    it('does nothing without cookies', async () => {
      await expect(service.logout(undefined, undefined)).resolves.toBeUndefined();
      expect(firebaseAuth.verifyIdToken).not.toHaveBeenCalled();
      expect(firebaseRest.refreshIdToken).not.toHaveBeenCalled();
    });

    it('swallows and logs a revocation failure', async () => {
      firebaseAuth.verifyIdToken.mockResolvedValue({ uid: FIREBASE_UID });
      firebaseAuth.revokeRefreshTokens.mockRejectedValue(new FirebaseUnavailableError());

      await expect(service.logout(ID_TOKEN, undefined)).resolves.toBeUndefined();
      expect(warnLog).toHaveBeenCalledWith(expect.stringContaining('Could not revoke'));
    });
  });

  describe('profile setup', () => {
    const identity: VerifiedIdentity = {
      uid: FIREBASE_UID,
      email: 'Alice.Smith@Gmail.com',
      name: 'Alice Smith',
    };
    const profileDto = { username: 'alice_s', displayName: 'Alice S.' };

    describe('getProfileSetup', () => {
      it('suggests the email local part with one query for all candidates', async () => {
        mockRows();
        mockTaken();

        await expect(service.getProfileSetup(identity)).resolves.toEqual({
          email: 'alice.smith@gmail.com',
          displayName: 'Alice Smith',
          suggestedUsername: 'alice.smith',
        });
        expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
        expect(prisma.user.findMany).toHaveBeenCalledWith({
          where: { username: { in: expect.arrayContaining(['alice.smith']) } },
          select: { username: true },
        });
      });

      it('adds a numeric suffix when the base is taken', async () => {
        mockRows();
        mockTaken((name) => name === 'alice.smith');

        const { suggestedUsername } = await service.getProfileSetup(identity);

        expect(suggestedUsername).toMatch(/^alice\.smith\d{4}$/);
      });

      it('falls back to a random user name when every other candidate is taken', async () => {
        mockRows();
        mockTaken((name) => name.startsWith('alice'));

        const { suggestedUsername } = await service.getProfileSetup(identity);

        expect(suggestedUsername).toMatch(/^user[0-9a-f]{8}$/);
      });

      it('uses the email local part when the token has no name', async () => {
        mockRows();
        mockTaken();

        const result = await service.getProfileSetup({ ...identity, name: '  ' });

        expect(result.displayName).toBe('alice.smith');
      });

      it('cuts a long name to the display name limit without splitting an emoji', async () => {
        mockRows();
        mockTaken();
        const name = `${'a'.repeat(49)}\u{1F600}\u{1F600}`;

        const { displayName } = await service.getProfileSetup({ ...identity, name });

        expect(displayName).toBe(`${'a'.repeat(49)}\u{1F600}`);
        expect(Array.from(displayName)).toHaveLength(50);
      });

      it('rejects a user who already has a profile', async () => {
        mockRows({ profile: true });

        await expect(service.getProfileSetup(identity)).rejects.toThrow(
          new ConflictException(PROFILE_ALREADY_EXISTS),
        );
        expect(prisma.user.findMany).not.toHaveBeenCalled();
      });

      it('rejects a token without an email', async () => {
        await expect(service.getProfileSetup({ ...identity, email: undefined })).rejects.toThrow(
          new BadRequestException(PROFILE_EMAIL_REQUIRED),
        );
      });
    });

    describe('completeProfileSetup', () => {
      it('inserts the row with the email from the token, lowercased', async () => {
        mockRows();
        prisma.user.create.mockResolvedValue(user);

        const result = await service.completeProfileSetup(identity, profileDto);

        expect(prisma.user.create).toHaveBeenCalledWith({
          data: {
            firebaseUid: FIREBASE_UID,
            email: 'alice.smith@gmail.com',
            username: 'alice_s',
            displayName: 'Alice S.',
          },
        });
        expect(result).toMatchObject({ id: user.id });
        expect(result).not.toHaveProperty('firebaseUid');
      });

      it('rejects a user who already has a profile', async () => {
        mockRows({ profile: true });

        await expect(service.completeProfileSetup(identity, profileDto)).rejects.toThrow(
          new ConflictException(PROFILE_ALREADY_EXISTS),
        );
        expect(prisma.user.create).not.toHaveBeenCalled();
      });

      it('rejects a taken username', async () => {
        mockRows({ username: true });

        await expect(service.completeProfileSetup(identity, profileDto)).rejects.toThrow(
          new ConflictException('Username is already taken'),
        );
        expect(prisma.user.create).not.toHaveBeenCalled();
      });

      it('rejects a token without an email', async () => {
        await expect(
          service.completeProfileSetup({ ...identity, email: undefined }, profileDto),
        ).rejects.toThrow(new BadRequestException(PROFILE_EMAIL_REQUIRED));
        expect(prisma.user.create).not.toHaveBeenCalled();
      });

      it.each([
        ['the profile was created concurrently', { id: 'row' }, null, PROFILE_ALREADY_EXISTS],
        ['the username was claimed concurrently', null, { id: 'row' }, 'Username is already taken'],
      ])('answers 409 when %s', async (_label, profileRow, usernameRow, message) => {
        // Before the insert: no profile, username free. After the unique violation: the
        // re-query finds the row that won the race.
        prisma.user.findUnique
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(profileRow)
          .mockResolvedValueOnce(usernameRow);
        prisma.user.create.mockRejectedValue(uniqueViolation());

        await expect(service.completeProfileSetup(identity, profileDto)).rejects.toThrow(
          new ConflictException(message),
        );
      });

      it('answers EmailAlreadyExistsError when another account owns the email', async () => {
        mockRows();
        prisma.user.create.mockRejectedValue(uniqueViolation());

        await expect(service.completeProfileSetup(identity, profileDto)).rejects.toBeInstanceOf(
          EmailAlreadyExistsError,
        );
      });

      it('rethrows other database errors and never deletes the Firebase account', async () => {
        mockRows();
        const failure = new Error('connection lost');
        prisma.user.create.mockRejectedValue(failure);

        await expect(service.completeProfileSetup(identity, profileDto)).rejects.toBe(failure);
        expect(firebaseAuth.deleteUser).not.toHaveBeenCalled();
      });
    });
  });
});
