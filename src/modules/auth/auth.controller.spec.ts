import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { cookieHeader, findSetCookie, setCookieValue } from '../../../test/helpers/cookies';
import { buildUser } from '../../../test/fixtures/user.fixture';
import { configureApp } from '../../app.setup';
import type { FirebaseSession } from '../../firebase/firebase-auth-rest.client';
import { FirebaseUnavailableError, TooManyAttemptsError } from '../../firebase/firebase.errors';
import type { User } from '../../generated/prisma/client';
import { AuthCookieService } from './auth-cookie.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UserResponseDto } from './dto/user-response.dto';

// HTTP-level tests of the controller with AuthService mocked: real routing, ValidationPipe,
// exception filter and cookie headers, but no database and no Firebase.

const user = buildUser();
const session: FirebaseSession = {
  uid: user.firebaseUid,
  idToken: 'id-token-1',
  refreshToken: 'refresh-token-1',
  expiresInSeconds: 3600,
};
const validSignup = {
  email: '  Alice@Example.COM ',
  password: 'secret123',
  username: 'Alice',
  displayName: '  Alice  ',
};

/** Stands in for FirebaseAuthGuard: lets every request through as `user`. */
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest<{ user?: User }>().user = user;
    return true;
  }
}

describe('AuthController (HTTP)', () => {
  const authService = {
    signup: jest.fn(),
    login: jest.fn(),
    refresh: jest.fn(),
    logout: jest.fn(),
  };
  let app: INestApplication<App>;

  beforeEach(async () => {
    jest.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        AuthCookieService,
        { provide: AuthService, useValue: authService },
        // COOKIE_SECURE=true, so the tests check the production flags.
        { provide: ConfigService, useValue: { get: () => true } },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
      ],
    }).compile();
    app = configureApp(moduleRef.createNestApplication<INestApplication<App>>({ logger: false }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /auth/signup', () => {
    it('normalises the input, returns 201 with the user and sets both cookies', async () => {
      authService.signup.mockResolvedValue({ user: UserResponseDto.fromUser(user), session });

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/signup')
        .send(validSignup)
        .expect(201);

      expect(authService.signup).toHaveBeenCalledWith({
        email: 'alice@example.com',
        password: 'secret123',
        username: 'alice',
        displayName: 'Alice',
      });
      expect(response.body).toMatchObject({ id: user.id, username: 'alice' });
      expect(response.body).not.toHaveProperty('firebaseUid');

      const idCookie = findSetCookie(response, 'rocky_id');
      expect(idCookie).toContain('rocky_id=id-token-1');
      expect(idCookie).toContain('Path=/;');
      expect(idCookie).toContain('Max-Age=3600');
      expect(idCookie).toContain('HttpOnly');
      expect(idCookie).toContain('Secure');
      expect(idCookie).toContain('SameSite=Lax');

      const refreshCookie = findSetCookie(response, 'rocky_refresh');
      expect(refreshCookie).toContain('rocky_refresh=refresh-token-1');
      expect(refreshCookie).toContain('Path=/api/v1/auth');
      expect(refreshCookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
      expect(refreshCookie).toContain('HttpOnly');
      expect(refreshCookie).toContain('Secure');
      expect(refreshCookie).toContain('SameSite=Lax');
    });

    it.each([
      ['an invalid email', { email: 'not-an-email' }, 'email must be a valid email address'],
      ['a short password', { password: 'abc123' }, 'password must be at least 8 characters long'],
      [
        'a password without a number',
        { password: 'onlyletters' },
        'password must contain at least one letter and one number',
      ],
      [
        'a password without a letter',
        { password: '12345678' },
        'password must contain at least one letter and one number',
      ],
      ['a short username', { username: 'ab' }, 'username must be between 3 and 30 characters long'],
      [
        'a username with invalid characters',
        { username: 'alice-smith' },
        'username may only contain lowercase letters, numbers, underscores and periods',
      ],
      [
        'a blank display name',
        { displayName: '   ' },
        'displayName must be between 1 and 50 characters long',
      ],
      ['an unknown field', { isAdmin: true }, 'property isAdmin should not exist'],
    ])('rejects %s with 400', async (_case, override, expectedMessage) => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/signup')
        .send({ ...validSignup, ...override })
        .expect(400);

      expect(response.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
      expect(response.body).toHaveProperty('message', expect.arrayContaining([expectedMessage]));
      expect(authService.signup).not.toHaveBeenCalled();
    });
  });

  describe('POST /auth/login', () => {
    it('returns 200 with the user and sets the cookies', async () => {
      authService.login.mockResolvedValue({ user: UserResponseDto.fromUser(user), session });

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'ALICE@example.com', password: 'secret123' })
        .expect(200);

      expect(authService.login).toHaveBeenCalledWith({
        email: 'alice@example.com',
        password: 'secret123',
      });
      expect(response.body).toMatchObject({ id: user.id });
      expect(setCookieValue(response, 'rocky_id')).toBe('id-token-1');
      expect(setCookieValue(response, 'rocky_refresh')).toBe('refresh-token-1');
    });

    it('rejects a missing password with 400', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'alice@example.com' })
        .expect(400);

      expect(authService.login).not.toHaveBeenCalled();
    });
  });

  describe('POST /auth/refresh', () => {
    it('passes the refresh cookie to the service and sets new cookies', async () => {
      authService.refresh.mockResolvedValue({ ...session, idToken: 'id-token-2' });

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookieHeader({ rocky_refresh: 'refresh-token-1' }))
        .expect(204);

      expect(authService.refresh).toHaveBeenCalledWith('refresh-token-1');
      expect(setCookieValue(response, 'rocky_id')).toBe('id-token-2');
      expect(setCookieValue(response, 'rocky_refresh')).toBe('refresh-token-1');
    });

    it('clears both cookies and returns 401 when the session is over', async () => {
      authService.refresh.mockRejectedValue(new UnauthorizedException('Session expired'));

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookieHeader({ rocky_refresh: 'refresh-token-1' }))
        .expect(401);

      expect(setCookieValue(response, 'rocky_id')).toBe('');
      expect(setCookieValue(response, 'rocky_refresh')).toBe('');
      expect(findSetCookie(response, 'rocky_refresh')).toContain('Path=/api/v1/auth');
    });

    it.each([
      [new FirebaseUnavailableError(), 503],
      [new TooManyAttemptsError(), 429],
    ])('keeps the cookies on %p', async (error, expectedStatus) => {
      authService.refresh.mockRejectedValue(error);

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookieHeader({ rocky_refresh: 'refresh-token-1' }))
        .expect(expectedStatus);

      expect(findSetCookie(response, 'rocky_id')).toBeUndefined();
      expect(findSetCookie(response, 'rocky_refresh')).toBeUndefined();
    });
  });

  describe('POST /auth/logout', () => {
    it('passes both cookies to the service, clears them and returns 204', async () => {
      authService.logout.mockResolvedValue(undefined);

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Cookie', cookieHeader({ rocky_id: 'id-token-1', rocky_refresh: 'refresh-token-1' }))
        .expect(204);

      expect(authService.logout).toHaveBeenCalledWith('id-token-1', 'refresh-token-1');
      expect(setCookieValue(response, 'rocky_id')).toBe('');
      expect(setCookieValue(response, 'rocky_refresh')).toBe('');
    });

    it('works without cookies', async () => {
      authService.logout.mockResolvedValue(undefined);

      await request(app.getHttpServer()).post('/api/v1/auth/logout').expect(204);

      expect(authService.logout).toHaveBeenCalledWith(undefined, undefined);
    });
  });

  describe('GET /auth/me', () => {
    it('returns the current user without firebaseUid', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/auth/me').expect(200);

      expect(response.body).toEqual({
        id: user.id,
        email: user.email,
        username: user.username,
        displayName: user.displayName,
        bio: null,
        avatarUrl: null,
        notificationsEnabled: true,
        language: 'en',
        createdAt: user.createdAt.toISOString(),
      });
    });
  });
});
