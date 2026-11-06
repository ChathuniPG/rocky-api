/**
 * Rate-limit policy (NFR-SEC-05). These are code constants rather than environment
 * variables: they are security policy that should be identical in every environment and
 * changed only through a reviewed pull request.
 *
 * Counters live in memory (the @nestjs/throttler default), which is correct only while the
 * API runs as a single process on a single instance. See ADR-012 for the limitation and
 * when to move to a shared store.
 */

/** Name of the single throttler (registered in AppModule); `@Throttle()` overrides use this key. */
export const DEFAULT_THROTTLER = 'default';

/** Window shared by all limits: one minute, in milliseconds. */
const ONE_MINUTE_MS = 60_000;

/** Global default: 100 requests per minute per client IP. */
export const DEFAULT_THROTTLE = { ttl: ONE_MINUTE_MS, limit: 100 } as const;

/**
 * Stricter limit for signup, login and refresh: 10 requests per minute per client IP. It
 * slows down credential stuffing and account-creation spam before any Firebase call.
 */
export const AUTH_THROTTLE = { ttl: ONE_MINUTE_MS, limit: 10 } as const;

/**
 * Stricter limit for POST /uploads: 20 requests per minute per client IP. Each request can
 * carry 25 MB that is buffered in memory and written to Firebase Storage, so the global
 * default would allow far more bandwidth, memory and storage cost than a real user needs.
 */
export const UPLOAD_THROTTLE = { ttl: ONE_MINUTE_MS, limit: 20 } as const;

/** Client message of a 429 response; the body itself is the standard error body. */
export const TOO_MANY_REQUESTS_MESSAGE = 'Too many requests, please try again later';
