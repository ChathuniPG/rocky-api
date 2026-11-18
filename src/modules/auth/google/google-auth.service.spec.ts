import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { FirebaseSession } from '../../../firebase/firebase-auth-rest.client';
import { FirebaseAuthRestClient } from '../../../firebase/firebase-auth-rest.client';
import { FirebaseAuthService } from '../../../firebase/firebase-auth.service';
import {
  EmailAlreadyExistsError,
  FirebaseUnavailableError,
  InvalidTokenError,
  UserDisabledError,
} from '../../../firebase/firebase.errors';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  GOOGLE_ACCOUNT_EXISTS_PATH,
  GOOGLE_SIGN_IN_FAILED_PATH,
  type GoogleCallbackQuery,
  GoogleAuthService,
} from './google-auth.service';
import { GoogleOAuthClient, GoogleTokenExchangeError } from './google-oauth.client';
import { parseOAuthCookie, serializeOAuthCookie } from './oauth-cookie';
import { toCodeChallenge } from './pkce';

// Google, Firebase and Prisma are mocked: no request leaves the process.

const STATE = 'state-abcdefghijklmnopqrstuvwxyz0123456789-_';
const CODE_VERIFIER = 'verifier-abcdefghijklmnopqrstuvwxyz0123456789';
const CODE = '4/0AfakeAuthorizationCode';
const GOOGLE_ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.fake-google-id-token.fake-signature';
const EMAIL = 'alice@gmail.com';

const session: FirebaseSession = {
  uid: 'firebase-uid-1',
  idToken: 'firebase-id-token',
  refreshToken: 'firebase-refresh-token',
  expiresInSeconds: 3600,
};

/** A valid rocky_oauth cookie for the attempt with STATE and CODE_VERIFIER. */
function cookieFor(returnTo = '/settings'): string {
  return serializeOAuthCookie({ state: STATE, codeVerifier: CODE_VERIFIER, returnTo });
}

/** The callback query Google sends after a successful consent screen. */
const successQuery: GoogleCallbackQuery = { code: CODE, state: STATE, error: undefined };

describe('GoogleAuthService', () => {
  const google = {
    buildAuthorizationUrl: jest.fn(),
    exchangeCode: jest.fn(),
    readIdTokenClaims: jest.fn(),
  };
  const firebaseAuth = { findSignInProviders: jest.fn() };
  const firebaseRest = { signInWithGoogleIdToken: jest.fn() };
  const prisma = { user: { findUnique: jest.fn() } };
  let warnSpy: jest.SpyInstance;
  let service: GoogleAuthService;

  beforeEach(async () => {
    jest.resetAllMocks();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    // Defaults: the happy path for a new Google user.
    google.buildAuthorizationUrl.mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?x');
    google.exchangeCode.mockResolvedValue(GOOGLE_ID_TOKEN);
    google.readIdTokenClaims.mockReturnValue({ email: EMAIL, emailVerified: true });
    firebaseAuth.findSignInProviders.mockResolvedValue(null);
    firebaseRest.signInWithGoogleIdToken.mockResolvedValue({ needConfirmation: false, session });
    prisma.user.findUnique.mockResolvedValue(null);

    const moduleRef = await Test.createTestingModule({
      providers: [
        GoogleAuthService,
        { provide: GoogleOAuthClient, useValue: google },
        { provide: FirebaseAuthService, useValue: firebaseAuth },
        { provide: FirebaseAuthRestClient, useValue: firebaseRest },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(GoogleAuthService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('startSignIn', () => {
    it('builds the authorization URL from a fresh state and the S256 challenge', () => {
      const { authorizationUrl, oauthCookie } = service.startSignIn('/settings');

      const stored = parseOAuthCookie(oauthCookie);
      expect(authorizationUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth?x');
      expect(stored).toEqual({
        state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown,
        codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown,
        returnTo: '/settings',
      });
      expect(google.buildAuthorizationUrl).toHaveBeenCalledWith({
        state: stored?.state,
        codeChallenge: toCodeChallenge(stored?.codeVerifier ?? ''),
      });
    });

    it('uses a new state and verifier for every attempt', () => {
      const first = parseOAuthCookie(service.startSignIn(undefined).oauthCookie);
      const second = parseOAuthCookie(service.startSignIn(undefined).oauthCookie);

      expect(second?.state).not.toBe(first?.state);
      expect(second?.codeVerifier).not.toBe(first?.codeVerifier);
    });

    it.each([undefined, '', '//evil.com', 'https://evil.com', '/login', '/welcome'])(
      'replaces an unsafe or missing returnTo %p with /',
      (returnTo) => {
        const stored = parseOAuthCookie(service.startSignIn(returnTo).oauthCookie);

        expect(stored?.returnTo).toBe('/');
      },
    );
  });

  describe('completeSignIn', () => {
    it('signs a new Google user in and sends them to /welcome, keeping returnTo', async () => {
      await expect(service.completeSignIn(successQuery, cookieFor('/settings'))).resolves.toEqual({
        redirectPath: '/welcome?returnTo=%2Fsettings',
        session,
      });

      expect(google.exchangeCode).toHaveBeenCalledWith(CODE, CODE_VERIFIER);
      expect(firebaseAuth.findSignInProviders).toHaveBeenCalledWith(EMAIL);
      expect(firebaseRest.signInWithGoogleIdToken).toHaveBeenCalledWith(GOOGLE_ID_TOKEN);
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { firebaseUid: session.uid },
        select: { id: true },
      });
    });

    it('sends an existing user to returnTo', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      firebaseAuth.findSignInProviders.mockResolvedValue(['google.com']);

      await expect(service.completeSignIn(successQuery, cookieFor('/u/alice'))).resolves.toEqual({
        redirectPath: '/u/alice',
        session,
      });
    });

    it('signs in an account that has both password and Google', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      firebaseAuth.findSignInProviders.mockResolvedValue(['password', 'google.com']);

      const outcome = await service.completeSignIn(successQuery, cookieFor('/'));

      expect(outcome).toEqual({ redirectPath: '/', session });
    });

    it('re-checks returnTo from the cookie', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });

      const outcome = await service.completeSignIn(successQuery, cookieFor('//evil.com'));

      expect(outcome.redirectPath).toBe('/');
    });

    describe('fails with /login?error=google and no session', () => {
      it.each([
        ['the cookie is missing', undefined],
        ['the cookie is malformed', 'not json'],
      ])('when %s', async (_label, cookie) => {
        await expect(service.completeSignIn(successQuery, cookie)).resolves.toEqual({
          redirectPath: GOOGLE_SIGN_IN_FAILED_PATH,
        });
        expect(google.exchangeCode).not.toHaveBeenCalled();
      });

      it('when the user cancels at Google (error=access_denied)', async () => {
        const query = { code: undefined, state: STATE, error: 'access_denied' };

        await expect(service.completeSignIn(query, cookieFor())).resolves.toEqual({
          redirectPath: GOOGLE_SIGN_IN_FAILED_PATH,
        });
        expect(google.exchangeCode).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(
          'Google sign-in failed: provider_error (access_denied)',
        );
      });

      it('when Google reports an error together with a code', async () => {
        const query = { ...successQuery, error: 'server_error' };

        const outcome = await service.completeSignIn(query, cookieFor());

        expect(outcome).toEqual({ redirectPath: GOOGLE_SIGN_IN_FAILED_PATH });
        expect(google.exchangeCode).not.toHaveBeenCalled();
      });

      it('without logging an error value that is not an OAuth code', async () => {
        const query = { code: undefined, state: STATE, error: `<script>${CODE}` };

        await service.completeSignIn(query, cookieFor());

        expect(warnSpy).toHaveBeenCalledWith('Google sign-in failed: provider_error');
      });

      it.each<[string, Partial<GoogleCallbackQuery>]>([
        ['the code is missing', { code: undefined }],
        ['the state is missing', { state: undefined }],
        ['the code is empty', { code: '' }],
        ['the code is repeated (an array)', { code: [CODE, CODE] }],
        ['the state is repeated (an array)', { state: [STATE, STATE] }],
        ['the code is over-long', { code: 'c'.repeat(2049) }],
        ['the state is over-long', { state: 's'.repeat(129) }],
      ])('when %s', async (_label, override) => {
        const outcome = await service.completeSignIn({ ...successQuery, ...override }, cookieFor());

        expect(outcome).toEqual({ redirectPath: GOOGLE_SIGN_IN_FAILED_PATH });
        expect(google.exchangeCode).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith('Google sign-in failed: invalid_callback_parameters');
      });

      it('when the state does not match the cookie', async () => {
        const query = { ...successQuery, state: `${STATE.slice(0, -1)}X` };

        await expect(service.completeSignIn(query, cookieFor())).resolves.toEqual({
          redirectPath: GOOGLE_SIGN_IN_FAILED_PATH,
        });
        expect(google.exchangeCode).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith('Google sign-in failed: state_mismatch');
      });

      it('when the token exchange fails', async () => {
        google.exchangeCode.mockRejectedValue(new GoogleTokenExchangeError());

        await expect(service.completeSignIn(successQuery, cookieFor())).resolves.toEqual({
          redirectPath: GOOGLE_SIGN_IN_FAILED_PATH,
        });
        expect(firebaseRest.signInWithGoogleIdToken).not.toHaveBeenCalled();
      });

      it('when the Google ID token has no usable claims', async () => {
        google.readIdTokenClaims.mockReturnValue(undefined);

        await expect(service.completeSignIn(successQuery, cookieFor())).resolves.toEqual({
          redirectPath: GOOGLE_SIGN_IN_FAILED_PATH,
        });
        expect(firebaseRest.signInWithGoogleIdToken).not.toHaveBeenCalled();
      });

      it('when Google has not verified the email', async () => {
        google.readIdTokenClaims.mockReturnValue({ email: EMAIL, emailVerified: false });

        await expect(service.completeSignIn(successQuery, cookieFor())).resolves.toEqual({
          redirectPath: GOOGLE_SIGN_IN_FAILED_PATH,
        });
        expect(firebaseRest.signInWithGoogleIdToken).not.toHaveBeenCalled();
      });

      it.each([new InvalidTokenError(), new UserDisabledError(), new FirebaseUnavailableError()])(
        'when Firebase signInWithIdp fails with %p',
        async (error) => {
          firebaseRest.signInWithGoogleIdToken.mockRejectedValue(error);

          await expect(service.completeSignIn(successQuery, cookieFor())).resolves.toEqual({
            redirectPath: GOOGLE_SIGN_IN_FAILED_PATH,
          });
          expect(warnSpy).toHaveBeenCalledWith(
            `Google sign-in failed: firebase_sign_in_failed (${error.code})`,
          );
        },
      );
    });

    describe('fails with /login?error=google_account_exists and no session', () => {
      it('when the email belongs to a password-only account, without calling Firebase sign-in', async () => {
        firebaseAuth.findSignInProviders.mockResolvedValue(['password']);

        await expect(service.completeSignIn(successQuery, cookieFor())).resolves.toEqual({
          redirectPath: GOOGLE_ACCOUNT_EXISTS_PATH,
        });
        // Calling signInWithIdp could make Firebase unlink the password (ADR-015).
        expect(firebaseRest.signInWithGoogleIdToken).not.toHaveBeenCalled();
      });

      it('when Firebase answers needConfirmation', async () => {
        firebaseRest.signInWithGoogleIdToken.mockResolvedValue({ needConfirmation: true });

        await expect(service.completeSignIn(successQuery, cookieFor())).resolves.toEqual({
          redirectPath: GOOGLE_ACCOUNT_EXISTS_PATH,
        });
        expect(prisma.user.findUnique).not.toHaveBeenCalled();
      });

      it('when Firebase reports EMAIL_EXISTS', async () => {
        firebaseRest.signInWithGoogleIdToken.mockRejectedValue(new EmailAlreadyExistsError());

        await expect(service.completeSignIn(successQuery, cookieFor())).resolves.toEqual({
          redirectPath: GOOGLE_ACCOUNT_EXISTS_PATH,
        });
      });
    });

    it('lets unexpected errors through for the callback filter', async () => {
      prisma.user.findUnique.mockRejectedValue(new Error('database down'));

      await expect(service.completeSignIn(successQuery, cookieFor())).rejects.toThrow(
        'database down',
      );
    });

    it('lets an outage of the provider lookup through for the callback filter', async () => {
      firebaseAuth.findSignInProviders.mockRejectedValue(new FirebaseUnavailableError());

      await expect(service.completeSignIn(successQuery, cookieFor())).rejects.toBeInstanceOf(
        FirebaseUnavailableError,
      );
      expect(firebaseRest.signInWithGoogleIdToken).not.toHaveBeenCalled();
    });

    it('never logs the code, state, verifier or tokens', async () => {
      await service.completeSignIn(successQuery, undefined);
      await service.completeSignIn({ ...successQuery, state: 'x' }, cookieFor());
      google.exchangeCode.mockRejectedValueOnce(new GoogleTokenExchangeError());
      await service.completeSignIn(successQuery, cookieFor());
      await service.completeSignIn(successQuery, cookieFor());

      const logged = JSON.stringify(warnSpy.mock.calls);
      for (const secret of [CODE, STATE, CODE_VERIFIER, GOOGLE_ID_TOKEN, session.idToken]) {
        expect(logged).not.toContain(secret);
      }
    });
  });
});
