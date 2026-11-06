import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import {
  EmailAlreadyExistsError,
  type FirebaseDomainError,
  FirebaseUnavailableError,
  InvalidCredentialsError,
  InvalidEmailError,
  InvalidTokenError,
  TokenExpiredError,
  TokenRevokedError,
  TooManyAttemptsError,
  UserDisabledError,
  UserNotFoundError,
  WeakPasswordError,
} from '../../firebase/firebase.errors';
import { Prisma } from '../../generated/prisma/client';
import { AllExceptionsFilter } from './all-exceptions.filter';

const SECRET = 'eyJhbGciOiJSUzI1NiJ9.secret-token';

/** Records what the filter writes, standing in for the Express response. */
class FakeResponse {
  statusCode?: number;
  body?: unknown;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): this {
    this.body = body;
    return this;
  }
}

/** Runs the filter on one exception and returns the response it wrote. */
function runFilter(exception: unknown, originalUrl = '/api/v1/auth/me'): FakeResponse {
  const response = new FakeResponse();
  const request = { method: 'GET', path: originalUrl.split('?')[0], originalUrl };

  new AllExceptionsFilter().catch(exception, new ExecutionContextHost([request, response]));

  return response;
}

/** A Prisma known request error whose message and meta carry data that must not leak. */
function knownError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`Constraint failed on ${SECRET}`, {
    code,
    clientVersion: 'test',
    meta: { target: ['email'], value: SECRET },
  });
}

describe('AllExceptionsFilter', () => {
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('writes the standard error body', () => {
    const response = runFilter(new NotFoundException('Post not found'));

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Post not found',
      path: '/api/v1/auth/me',
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) as unknown,
    });
  });

  it('drops the query string from path', () => {
    const response = runFilter(new NotFoundException(), '/api/v1/users/search?q=alice');

    expect(response.body).toMatchObject({ path: '/api/v1/users/search' });
  });

  it('keeps the message list produced by ValidationPipe', () => {
    const exception = new BadRequestException(['email must be an email', 'password is too short']);

    const response = runFilter(exception);

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      error: 'Bad Request',
      message: ['email must be an email', 'password is too short'],
    });
  });

  it.each([
    [new UnauthorizedException('Authentication required'), 401, 'Authentication required'],
    [new ConflictException('Username is already taken'), 409, 'Username is already taken'],
  ])('passes %p through', (exception, expectedStatus, expectedMessage) => {
    const response = runFilter(exception);

    expect(response.statusCode).toBe(expectedStatus);
    expect(response.body).toMatchObject({ message: expectedMessage });
  });

  describe('Firebase domain errors', () => {
    it.each<[FirebaseDomainError, number, string]>([
      [new InvalidCredentialsError(), 401, 'Invalid email or password'],
      [new EmailAlreadyExistsError(), 409, 'The email address is already in use'],
      [new InvalidEmailError(), 400, 'The email address is invalid'],
      [new WeakPasswordError(), 400, 'The password does not meet the password requirements'],
      [new UserNotFoundError(), 404, 'The user does not exist'],
      [new UserDisabledError(), 403, 'The user account is disabled'],
      [new TooManyAttemptsError(), 429, 'Too many attempts, try again later'],
      [new TokenExpiredError(), 401, 'The token has expired'],
      [new TokenRevokedError(), 401, 'The token has been revoked'],
      [new InvalidTokenError(), 401, 'The token is invalid'],
      [new FirebaseUnavailableError(), 503, 'Service temporarily unavailable'],
    ])('maps %p to %i', (error, expectedStatus, expectedMessage) => {
      const response = runFilter(error);

      expect(response.statusCode).toBe(expectedStatus);
      expect(response.body).toMatchObject({ statusCode: expectedStatus, message: expectedMessage });
    });

    it('logs FirebaseUnavailableError without its cause', () => {
      const error = new FirebaseUnavailableError({ cause: new Error(`raw ${SECRET}`) });

      const response = runFilter(error);

      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(SECRET);
      expect(JSON.stringify(response.body)).not.toContain(SECRET);
    });

    it('does not log client errors such as invalid credentials', () => {
      runFilter(new InvalidCredentialsError());

      expect(errorLog).not.toHaveBeenCalled();
    });
  });

  describe('Prisma errors', () => {
    it.each<[string, number, string]>([
      ['P2002', 409, 'Resource already exists'],
      ['P2003', 404, 'Related resource not found'],
      ['P2025', 404, 'Resource not found'],
      ['P1001', 503, 'Service temporarily unavailable'],
      ['P1017', 503, 'Service temporarily unavailable'],
      ['P2010', 500, 'Internal server error'],
    ])('maps %s to %i', (code, expectedStatus, expectedMessage) => {
      const response = runFilter(knownError(code));

      expect(response.statusCode).toBe(expectedStatus);
      expect(response.body).toMatchObject({ statusCode: expectedStatus, message: expectedMessage });
      expect(JSON.stringify(response.body)).not.toContain(SECRET);
    });

    it('maps an initialization error (database unreachable) to 503', () => {
      const error = new Prisma.PrismaClientInitializationError(
        `Can't reach database server at ${SECRET}`,
        'test',
        'P1001',
      );

      const response = runFilter(error);

      expect(response.statusCode).toBe(503);
      expect(response.body).toMatchObject({ message: 'Service temporarily unavailable' });
      expect(JSON.stringify(response.body)).not.toContain(SECRET);
    });

    it('logs only the name and code of server-side failures', () => {
      runFilter(knownError('P2010'));

      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(
        'GET /api/v1/auth/me failed: PrismaClientKnownRequestError P2010',
      );
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(SECRET);
    });

    it('does not log client errors such as a unique violation', () => {
      runFilter(knownError('P2002'));

      expect(errorLog).not.toHaveBeenCalled();
    });
  });

  describe('unknown errors', () => {
    it('returns a generic 500 without the internal message or stack', () => {
      const error = new Error(`Prisma failed: connection to ${SECRET} refused`);

      const response = runFilter(error);

      expect(response.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(response.body).toMatchObject({
        error: 'Internal Server Error',
        message: 'Internal server error',
      });
      expect(JSON.stringify(response.body)).not.toContain(SECRET);
      expect(JSON.stringify(response.body)).not.toContain('at ');
    });

    it('logs the stack server-side', () => {
      const error = new Error('boom');

      runFilter(error);

      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('unexpected error'),
        error.stack,
      );
    });

    it('handles thrown non-Error values', () => {
      const response = runFilter('a string was thrown');

      expect(response.statusCode).toBe(500);
      expect(response.body).toMatchObject({ message: 'Internal server error' });
    });
  });
});
