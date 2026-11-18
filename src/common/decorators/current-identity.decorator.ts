import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { IdentifiedRequest, VerifiedIdentity } from '../auth/authenticated-request';

/**
 * Returns the verified Firebase identity that `FirebaseAuthGuard` attached to the request.
 * Exported separately from the decorator so it can be unit-tested.
 *
 * @param _data - Unused decorator argument.
 * @param context - The current execution context.
 * @returns The uid, email and name from the verified ID token.
 */
export function currentIdentityFactory(
  _data: unknown,
  context: ExecutionContext,
): VerifiedIdentity {
  return context.switchToHttp().getRequest<IdentifiedRequest>().identity;
}

/**
 * Injects the verified Firebase identity into a controller parameter. Unlike
 * `@CurrentUser()` it also works for users without a users row, so it is the decorator to
 * use on `@AllowIncompleteProfile()` routes. Not available on `@Public()` routes.
 *
 * @example
 *   @AllowIncompleteProfile()
 *   @Get('profile-setup')
 *   getProfileSetup(@CurrentIdentity() identity: VerifiedIdentity) { ... }
 */
export const CurrentIdentity = createParamDecorator(currentIdentityFactory);
