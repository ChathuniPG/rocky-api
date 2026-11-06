import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { STATUS_CODES } from 'node:http';
import { FirebaseDomainError, type FirebaseErrorCode } from '../../firebase/firebase.errors';
import { Prisma } from '../../generated/prisma/client';

/** JSON body of every error response (design §5.1). */
export interface ErrorResponseBody {
  statusCode: number;
  /** Standard reason phrase of the status, e.g. "Unauthorized". */
  error: string;
  /** Safe, client-facing message. Validation errors return one message per failed rule. */
  message: string | string[];
  path: string;
  timestamp: string;
}

/** Status and client message chosen for one exception. */
export interface MappedError {
  status: number;
  message: string | string[];
}

const INTERNAL_ERROR_MESSAGE = 'Internal server error';
const SERVICE_UNAVAILABLE_MESSAGE = 'Service temporarily unavailable';

/**
 * Global exception filter: turns every exception into the standard JSON error body
 * (design §5.1). Similar to a Spring `@ControllerAdvice` with a catch-all handler.
 *
 * - `HttpException`: its own status and message.
 * - `FirebaseDomainError`: mapped to an HTTP status (see {@link mapFirebaseError}).
 * - Prisma errors: mapped to an HTTP status (see {@link mapPrismaError}).
 * - Anything else: 500 with a generic message. The stack trace is logged server-side and
 *   never sent to the client, nor are raw Firebase or Prisma messages (NFR-OPS-02).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  /**
   * Writes the error response for one exception.
   *
   * @param exception - Whatever was thrown.
   * @param host - Gives access to the Express request and response.
   */
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const { status, message } = this.mapException(exception, request);
    const body: ErrorResponseBody = {
      statusCode: status,
      error: STATUS_CODES[status] ?? 'Error',
      message,
      // originalUrl keeps the global prefix (/api/v1/...); the query string is dropped
      // because it can carry user input that has no place in an error body.
      path: request.originalUrl.split('?')[0],
      timestamp: new Date().toISOString(),
    };

    response.status(status).json(body);
  }

  private mapException(exception: unknown, request: Request): MappedError {
    if (exception instanceof HttpException) {
      return { status: exception.getStatus(), message: readHttpExceptionMessage(exception) };
    }

    if (exception instanceof FirebaseDomainError) {
      const mapped = mapFirebaseError(exception);
      if (mapped.status >= 500) {
        // Name and code only: the domain error's `cause` may hold the raw Firebase error.
        this.logger.error(`${request.method} ${request.path} failed: ${exception.name}`);
      }
      return mapped;
    }

    if (
      exception instanceof Prisma.PrismaClientKnownRequestError ||
      exception instanceof Prisma.PrismaClientInitializationError
    ) {
      const mapped = mapPrismaError(exception);
      if (mapped.status >= 500) {
        // Name and code only: Prisma messages and `meta` can contain column values.
        this.logger.error(
          `${request.method} ${request.path} failed: ${exception.name} ${prismaErrorCode(exception)}`,
        );
      }
      return mapped;
    }

    // Unknown error: a bug or an unhandled infrastructure failure. Log the stack for
    // debugging; the client only gets a generic message.
    const stack = exception instanceof Error ? exception.stack : String(exception);
    this.logger.error(`${request.method} ${request.path} failed with an unexpected error`, stack);
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: INTERNAL_ERROR_MESSAGE };
  }
}

/**
 * HTTP mapping of every Firebase domain error. Typed as a `Record` over all codes, so
 * adding a new `FirebaseErrorCode` is a compile error until it is mapped here.
 *
 * `message` overrides the domain error's own message where a different client message is
 * needed. Otherwise the domain message is used: it is a fixed, safe string
 * (see firebase.errors.ts).
 */
const FIREBASE_ERROR_MAPPING: Record<FirebaseErrorCode, { status: HttpStatus; message?: string }> =
  {
    // Design §3.4: one message for wrong password and unknown email.
    INVALID_CREDENTIALS: { status: HttpStatus.UNAUTHORIZED, message: 'Invalid email or password' },
    EMAIL_ALREADY_EXISTS: { status: HttpStatus.CONFLICT },
    INVALID_EMAIL: { status: HttpStatus.BAD_REQUEST },
    WEAK_PASSWORD: { status: HttpStatus.BAD_REQUEST },
    USER_NOT_FOUND: { status: HttpStatus.NOT_FOUND },
    USER_DISABLED: { status: HttpStatus.FORBIDDEN },
    TOO_MANY_ATTEMPTS: { status: HttpStatus.TOO_MANY_REQUESTS },
    TOKEN_EXPIRED: { status: HttpStatus.UNAUTHORIZED },
    TOKEN_REVOKED: { status: HttpStatus.UNAUTHORIZED },
    INVALID_TOKEN: { status: HttpStatus.UNAUTHORIZED },
    FIREBASE_UNAVAILABLE: {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      message: SERVICE_UNAVAILABLE_MESSAGE,
    },
  };

/**
 * Maps a Firebase domain error to an HTTP status and safe client message.
 *
 * @param error - The domain error thrown by the Firebase module.
 * @returns The HTTP status and client message.
 */
export function mapFirebaseError(error: FirebaseDomainError): MappedError {
  const { status, message } = FIREBASE_ERROR_MAPPING[error.code];
  return { status, message: message ?? error.message };
}

/**
 * HTTP mapping of the Prisma error codes a request can legitimately trigger. Services may
 * catch a code first to give a more specific message (e.g. "Username is already taken");
 * this table is the safety net, so a raw Prisma error never reaches the client.
 * Codes: https://www.prisma.io/docs/orm/reference/error-reference
 */
const PRISMA_ERROR_MAPPING: Readonly<Record<string, MappedError>> = {
  // Unique constraint violation, e.g. a duplicate like that slipped past a check.
  P2002: { status: HttpStatus.CONFLICT, message: 'Resource already exists' },
  // Foreign key violation: in this schema it means the referenced post, user or
  // conversation does not exist (or was deleted concurrently), so 404 rather than 400.
  P2003: { status: HttpStatus.NOT_FOUND, message: 'Related resource not found' },
  // update/delete on a row that does not exist.
  P2025: { status: HttpStatus.NOT_FOUND, message: 'Resource not found' },
  // Database unreachable, timed out or closed the connection: an outage, not a bug.
  P1001: { status: HttpStatus.SERVICE_UNAVAILABLE, message: SERVICE_UNAVAILABLE_MESSAGE },
  P1002: { status: HttpStatus.SERVICE_UNAVAILABLE, message: SERVICE_UNAVAILABLE_MESSAGE },
  P1008: { status: HttpStatus.SERVICE_UNAVAILABLE, message: SERVICE_UNAVAILABLE_MESSAGE },
  P1017: { status: HttpStatus.SERVICE_UNAVAILABLE, message: SERVICE_UNAVAILABLE_MESSAGE },
};

/**
 * Maps a Prisma error to an HTTP status and a fixed, safe client message. The Prisma
 * message is never used: it can contain table, column and value details.
 *
 * @param error - A known request error (has a `P` code) or an initialization error
 *   (the database could not be reached).
 * @returns 409/404/503 for the codes in the mapping, 503 for initialization errors,
 *   and 500 for everything else.
 */
export function mapPrismaError(
  error: Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientInitializationError,
): MappedError {
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return { status: HttpStatus.SERVICE_UNAVAILABLE, message: SERVICE_UNAVAILABLE_MESSAGE };
  }
  return (
    PRISMA_ERROR_MAPPING[error.code] ?? {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: INTERNAL_ERROR_MESSAGE,
    }
  );
}

/** The Prisma error code for logs, e.g. "P1001"; "no code" if Prisma did not set one. */
function prismaErrorCode(
  error: Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientInitializationError,
): string {
  const code = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : error.errorCode;
  return code ?? 'no code';
}

/**
 * Reads the client message of an `HttpException`. Nest builds a `{ message }` object for
 * exceptions thrown with a string, and ValidationPipe puts one string per failed rule in
 * `message`.
 */
function readHttpExceptionMessage(exception: HttpException): string | string[] {
  const response = exception.getResponse();
  if (typeof response === 'string') {
    return response;
  }
  if (typeof response === 'object' && response !== null && 'message' in response) {
    const { message } = response;
    if (typeof message === 'string') {
      return message;
    }
    if (Array.isArray(message) && message.every((item) => typeof item === 'string')) {
      return message;
    }
  }
  return exception.message;
}
