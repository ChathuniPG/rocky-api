import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { User } from '../../generated/prisma/client';
import type { AuthenticatedRequest } from '../auth/authenticated-request';

/**
 * Returns the user that `FirebaseAuthGuard` attached to the request. Exported separately
 * from the decorator so it can be unit-tested.
 *
 * @param _data - Unused decorator argument.
 * @param context - The current execution context.
 * @returns The signed-in user's row from PostgreSQL.
 */
export function currentUserFactory(_data: unknown, context: ExecutionContext): User {
  return context.switchToHttp().getRequest<AuthenticatedRequest>().user;
}

/**
 * Injects the signed-in user into a controller parameter (design §3.5), like
 * `@AuthenticationPrincipal` in Spring Security. Only use it on routes that are not
 * `@Public()`: on public routes no user is attached.
 *
 * @example
 *   @Get('me')
 *   me(@CurrentUser() user: User) { ... }
 */
export const CurrentUser = createParamDecorator(currentUserFactory);
