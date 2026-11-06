import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { FirebaseAuthService } from '../../firebase/firebase-auth.service';
import type { User } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ID_TOKEN_COOKIE, readCookie } from '../auth/auth-cookies';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/** Message for every "you are not signed in" response from the guard. */
export const AUTHENTICATION_REQUIRED = 'Authentication required';

/**
 * Global authentication guard (design §3.5, NFR-SEC-01), registered with `APP_GUARD`, so
 * every route requires a signed-in user unless it is marked `@Public()`. Comparable to a
 * Spring Security filter that authenticates every request by default.
 *
 * On success, the user's PostgreSQL row is attached as `request.user`, making the request
 * an `AuthenticatedRequest` (see `@CurrentUser()`). Token failures are thrown as Firebase domain errors and turned into
 * 401/403/503 responses by the global exception filter.
 */
@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly firebaseAuth: FirebaseAuthService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Authenticates the request from the rocky_id cookie.
   *
   * @param context - The current execution context.
   * @returns `true` if the route is public or the user is authenticated.
   * @throws {UnauthorizedException} If the cookie is missing or no user row matches the token.
   * @throws {FirebaseDomainError} If the token is expired, revoked or invalid, the user
   *   is disabled, or Firebase is unavailable.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.isPublic(context)) {
      return true;
    }

    // `user` is optional until this guard sets it; afterwards handlers see it as
    // AuthenticatedRequest.
    const request = context.switchToHttp().getRequest<Request & { user?: User }>();
    const idToken = readCookie(request, ID_TOKEN_COOKIE);
    if (!idToken) {
      throw new UnauthorizedException(AUTHENTICATION_REQUIRED);
    }

    // checkRevoked is always on (design §3.5), so logout takes effect immediately.
    const decoded = await this.firebaseAuth.verifyIdToken(idToken);

    const user = await this.prisma.user.findUnique({ where: { firebaseUid: decoded.uid } });
    if (!user) {
      // A valid Firebase user without a users row (e.g. a sign-up whose compensating
      // delete failed) must not reach any route that expects a profile.
      throw new UnauthorizedException(AUTHENTICATION_REQUIRED);
    }

    request.user = user;
    return true;
  }

  /** A handler-level `@Public()` wins over the controller, then the controller is checked. */
  private isPublic(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }
}
