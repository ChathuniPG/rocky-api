import { applyDecorators, HttpStatus } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { ErrorResponseDto } from './error-response.dto';

/** Default description of each documented error status. */
const ERROR_DESCRIPTIONS: Readonly<Partial<Record<HttpStatus, string>>> = {
  [HttpStatus.BAD_REQUEST]: 'Validation failed; `message` lists every failed rule.',
  [HttpStatus.UNAUTHORIZED]: 'Not signed in, or the session is invalid or expired.',
  [HttpStatus.FORBIDDEN]: 'The account is disabled.',
  [HttpStatus.NOT_FOUND]: 'The resource does not exist.',
  [HttpStatus.CONFLICT]: 'The resource already exists.',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'The request body or uploaded file is too large.',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Rate limit exceeded; see the Retry-After header.',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'A backing service (Firebase or the database) is unavailable.',
};

/** One documented error: a status, optionally with an endpoint-specific description. */
export type ApiErrorSpec = HttpStatus | { status: HttpStatus; description: string };

/**
 * Documents error responses that use the standard error body (design §5.1), e.g.
 * `@ApiErrorResponses(HttpStatus.BAD_REQUEST, HttpStatus.TOO_MANY_REQUESTS)`.
 *
 * @param errors - Statuses, or status/description pairs to override the default text.
 * @returns A decorator applying one `@ApiResponse` per error.
 */
export function ApiErrorResponses(...errors: ApiErrorSpec[]): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ...errors.map((error) => {
      const { status, description } =
        typeof error === 'number'
          ? { status: error, description: ERROR_DESCRIPTIONS[error] ?? 'Error.' }
          : error;
      return ApiResponse({ status, description, type: ErrorResponseDto });
    }),
  );
}
