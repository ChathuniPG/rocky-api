import type { Logger } from '@nestjs/common';
import { type FirebaseDomainError, FirebaseUnavailableError } from './firebase.errors';

/** Maps a Firebase error code to a factory for the matching domain error. */
export type ErrorCodeMapping = Readonly<Record<string, () => FirebaseDomainError>>;

/**
 * Reads the `code` of a Firebase Admin SDK error (e.g. "auth/id-token-expired") without
 * `any`: SDK errors are caught as `unknown` and narrowed here.
 *
 * @returns The code, or `undefined` if the error has no string `code`.
 */
export function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

/**
 * Reads the numeric HTTP status of a Google Cloud Storage error. GCS `ApiError.code` is a
 * number (e.g. 404), unlike the string codes of the Auth SDK read by {@link readErrorCode}.
 *
 * @returns The status, or `undefined` if the error has no numeric `code`.
 */
export function readHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'number' ? error.code : undefined;
}

/**
 * Translates a Firebase error code into a domain error using `mapping`. An unmapped code
 * is unexpected, so it is logged (by code only, because SDK and REST messages can echo
 * user input) and reported as `FirebaseUnavailableError` with `cause` as its cause.
 *
 * @param code - The Firebase error code, if one could be read.
 * @param cause - The original error, kept for server-side diagnostics only.
 * @param mapping - The expected codes for this operation.
 * @param operation - Operation name for the log line, e.g. "verifyIdToken".
 * @param logger - Logger of the calling service.
 * @returns The domain error to throw.
 */
export function toDomainError(
  code: string | undefined,
  cause: unknown,
  mapping: ErrorCodeMapping,
  operation: string,
  logger: Logger,
): FirebaseDomainError {
  // Object.hasOwn: a code such as "constructor" must not match Object.prototype members.
  if (code !== undefined && Object.hasOwn(mapping, code)) {
    return mapping[code]();
  }

  logger.error(`Firebase ${operation} failed with unexpected error code: ${code ?? 'none'}`);
  return new FirebaseUnavailableError({ cause });
}
