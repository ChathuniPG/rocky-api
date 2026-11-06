import { Prisma } from '../generated/prisma/client';

/** Prisma error code for a unique constraint violation. */
export const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

/**
 * Tells whether an error is a unique constraint violation, e.g. a concurrent request
 * that inserted the same value between a service's check and its insert.
 *
 * @param error - Anything caught from a Prisma call.
 * @returns `true` for a P2002 known request error.
 */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === UNIQUE_CONSTRAINT_VIOLATION
  );
}
