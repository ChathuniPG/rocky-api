import { SetMetadata } from '@nestjs/common';

/** Metadata key read by `FirebaseAuthGuard` to skip authentication. */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route handler or controller as public, so the global `FirebaseAuthGuard` does
 * not require the rocky_id cookie (NFR-SEC-01: only sign-up, login, health and the
 * cookie-based auth endpoints are public). Similar to `permitAll()` in Spring Security.
 *
 * @returns A decorator usable on a method or a class.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
