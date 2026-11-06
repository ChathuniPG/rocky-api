import { Logger } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { User } from '../../generated/prisma/client';

/** Express middleware signature, as accepted by `app.use()`. */
export type RequestLoggingMiddleware = RequestHandler;

/** Options of {@link createRequestLoggingMiddleware}. */
export interface RequestLoggingOptions {
  /**
   * Full paths (including the global prefix) whose successful responses are not logged,
   * e.g. the health check: frequent probes would drown real traffic. Failures still are.
   */
  quietPaths?: readonly string[];
  /** The logger to write to; injectable for tests. */
  logger?: Logger;
}

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

/**
 * Creates the request-logging middleware (NFR-OPS-04). It logs one line per request
 * after the response is sent, for example:
 *
 *     POST /api/v1/auth/login 401 12.4ms
 *     GET /api/v1/auth/me 200 8.1ms user=4b0c...
 *
 * It is a middleware, not an interceptor, because interceptors run after guards and would
 * miss the 401, 429 and 404 responses that guards and unknown routes produce. (In Spring
 * terms: a servlet Filter rather than a HandlerInterceptor.)
 *
 * Only the method, path (without the query string), status, duration and user id are
 * logged. Bodies, headers, cookies and tokens never are.
 *
 * @param options - Quiet paths and an optional logger (see {@link RequestLoggingOptions}).
 * @returns The Express middleware.
 */
export function createRequestLoggingMiddleware(
  options: RequestLoggingOptions = {},
): RequestLoggingMiddleware {
  const logger = options.logger ?? new Logger('HTTP');
  const quietPaths: ReadonlySet<string> = new Set(options.quietPaths ?? []);

  return (request: Request, response: Response, next: NextFunction): void => {
    const startedAt = process.hrtime.bigint();

    // 'close' fires for every request, including when the client disconnects before the
    // response is complete; 'finish' would silently skip those.
    response.once('close', () => {
      logRequest(logger, quietPaths, request, response, startedAt);
    });

    next();
  };
}

function logRequest(
  logger: Logger,
  quietPaths: ReadonlySet<string>,
  request: Request,
  response: Response,
  startedAt: bigint,
): void {
  // The query string can carry search terms and other user input: never logged.
  const path = request.originalUrl.split('?')[0];
  const status = response.statusCode;

  if (status < 400 && quietPaths.has(path)) {
    return;
  }

  const durationMs = formatDuration(process.hrtime.bigint() - startedAt);
  // Set by FirebaseAuthGuard on the same request object before the handler runs.
  const userId = (request as Request & { user?: Pick<User, 'id'> }).user?.id;
  const aborted = response.writableFinished ? '' : ' (aborted)';

  const line = `${request.method} ${path} ${status} ${durationMs}ms${userId ? ` user=${userId}` : ''}${aborted}`;

  if (status >= 500) {
    logger.error(line);
  } else if (status >= 400) {
    logger.warn(line);
  } else {
    logger.log(line);
  }
}

/** Nanoseconds to milliseconds with one decimal place, e.g. 12_400_000n → "12.4". */
function formatDuration(nanoseconds: bigint): string {
  const tenthsOfMs = (nanoseconds * 10n) / NANOSECONDS_PER_MILLISECOND;
  return (Number(tenthsOfMs) / 10).toFixed(1);
}
