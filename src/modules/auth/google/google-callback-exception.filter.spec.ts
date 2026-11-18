import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { ThrottlerException } from '@nestjs/throttler';
import type { EnvironmentVariables } from '../../../config/env.validation';
import { AuthCookieService } from '../auth-cookie.service';
import { GoogleCallbackExceptionFilter } from './google-callback-exception.filter';

/** Records what the filter writes, standing in for the Express response. */
class FakeResponse {
  headersSent = false;
  redirectedTo?: { status: number; url: string };
  readonly clearedCookies: string[] = [];

  clearCookie(name: string): this {
    this.clearedCookies.push(name);
    return this;
  }

  redirect(status: number, url: string): void {
    this.redirectedTo = { status, url };
  }
}

function runFilter(exception: unknown, response = new FakeResponse()): FakeResponse {
  const cookies = new AuthCookieService(
    new ConfigService<EnvironmentVariables, true>({ COOKIE_SECURE: true }),
  );
  new GoogleCallbackExceptionFilter(cookies).catch(
    exception,
    new ExecutionContextHost([{}, response]),
  );
  return response;
}

describe('GoogleCallbackExceptionFilter', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['a rate-limit 429', new ThrottlerException()],
    ['a validation 400', new BadRequestException()],
    ['an unexpected error', new Error('database down')],
    ['a thrown non-error', 'oops'],
  ])('turns %s into a redirect to /login?error=google and clears rocky_oauth', (_label, error) => {
    const response = runFilter(error);

    expect(response.redirectedTo).toEqual({ status: 302, url: '/login?error=google' });
    expect(response.clearedCookies).toEqual(['rocky_oauth']);
  });

  it('logs the error by name only', () => {
    runFilter(new Error('secret code 4/0Afake in the message'));

    expect(errorSpy).toHaveBeenCalledWith(
      'Google sign-in callback failed: Error',
      expect.any(String),
    );
    expect(JSON.stringify(errorSpy.mock.calls[0][0])).not.toContain('4/0Afake');
  });

  it('does nothing more once the response has started', () => {
    const response = new FakeResponse();
    response.headersSent = true;

    runFilter(new Error('late'), response);

    expect(response.redirectedTo).toBeUndefined();
  });
});
