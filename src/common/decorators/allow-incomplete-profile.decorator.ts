import { SetMetadata } from '@nestjs/common';

/** Metadata key read by `FirebaseAuthGuard` to admit users without a users row. */
export const ALLOW_INCOMPLETE_PROFILE_KEY = 'allowIncompleteProfile';

/**
 * Lets a signed-in user whose profile is not set up yet (a valid Firebase ID token but no
 * users row, e.g. a new Google user) reach a route. Everywhere else such a user gets
 * `403 PROFILE_INCOMPLETE`. The token is still required and verified; use
 * `@CurrentIdentity()` in the handler, because `@CurrentUser()` may be undefined.
 *
 * Only the profile-setup endpoints use it (issue #42). Logout is `@Public()` and needs no
 * marker.
 *
 * @returns A decorator usable on a method or a class.
 */
export const AllowIncompleteProfile = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_INCOMPLETE_PROFILE_KEY, true);
