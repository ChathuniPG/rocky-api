import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthCookieService } from '../auth-cookie.service';
import { GOOGLE_SIGN_IN_FAILED_PATH } from './google-auth.service';

/**
 * Route-scoped safety net for GET /auth/google/callback (issue #42): the callback is a
 * browser navigation coming back from Google, so it must never answer with the JSON error
 * body of the global filter. Any exception there, including a rate-limit 429 from the
 * throttler guard (guard exceptions pass through route filters too) or an unexpected
 * database error, clears rocky_oauth and redirects to the login page's generic error.
 *
 * Expected failures (bad state, cancelled consent, ...) never reach this filter: the
 * service turns them into redirects itself.
 */
@Catch()
export class GoogleCallbackExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GoogleCallbackExceptionFilter.name);

  constructor(private readonly cookies: AuthCookieService) {}

  /**
   * Redirects to the generic Google sign-in error page.
   *
   * @param exception - Whatever was thrown.
   * @param host - Gives access to the Express response.
   */
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    // Name only: messages of unexpected errors can contain request data.
    const name = exception instanceof Error ? exception.name : 'unknown error';
    const stack = exception instanceof Error ? exception.stack : undefined;
    this.logger.error(`Google sign-in callback failed: ${name}`, stack);

    if (response.headersSent) {
      return;
    }
    this.cookies.clearOAuthCookie(response);
    response.redirect(HttpStatus.FOUND, GOOGLE_SIGN_IN_FAILED_PATH);
  }
}
