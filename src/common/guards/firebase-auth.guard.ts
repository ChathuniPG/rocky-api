import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { DecodedIdToken } from '../../firebase/firebase-auth.service';
import { FirebaseAuthService } from '../../firebase/firebase-auth.service';
import type { User } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ID_TOKEN_COOKIE, readCookie } from '../auth/auth-cookies';
import type { VerifiedIdentity } from '../auth/authenticated-request';
import { ALLOW_INCOMPLETE_PROFILE_KEY } from '../decorators/allow-incomplete-profile.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/** Message for every "you are not signed in" response from the guard. */
export const AUTHENTICATION_REQUIRED = 'Authentication required';

/** Machine-readable `code` of the 403 for a signed-in user without a profile (issue #42). */
export const PROFILE_INCOMPLETE = 'PROFILE_INCOMPLETE';

/** Client message of the PROFILE_INCOMPLETE response. */
export const PROFILE_SETUP_REQUIRED = 'Profile setup required';

/**
 * Global authentication guard (design §3.5, NFR-SEC-01), registered with `APP_GUARD`, so
 * every route requires a signed-in user unless it is marked `@Public()`. Comparable to a
 * Spring Security filter that authenticates every request by default.
 *
 * On success, the verified token's identity is attached as `request.identity` and the
 * user's PostgreSQL row as `request.user` (see `@CurrentIdentity()` and `@CurrentUser()`).
 * A valid token without a users row is rejected with `403 PROFILE_INCOMPLETE`, except on
 * `@AllowIncompleteProfile()` routes. Token failures are thrown as Firebase domain errors
 * and turned into 401/403/503 responses by the global exception filter.
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
   * @throws {UnauthorizedException} If the rocky_id cookie is missing.
   * @throws {ForbiddenException} With `code: "PROFILE_INCOMPLETE"` if the token is valid
   *   but no users row exists and the route is not `@AllowIncompleteProfile()`.
   * @throws {FirebaseDomainError} If the token is expired, revoked or invalid, the user
   *   is disabled, or Firebase is unavailable.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.hasFlag(context, IS_PUBLIC_KEY)) {
      return true;
    }

    // `identity` and `user` are optional until this guard sets them; afterwards handlers
    // see the request as IdentifiedRequest / AuthenticatedRequest.
    const request = context
      .switchToHttp()
      .getRequest<Request & { identity?: VerifiedIdentity; user?: User }>();
    const idToken = readCookie(request, ID_TOKEN_COOKIE);
    if (!idToken) {
      throw new UnauthorizedException(AUTHENTICATION_REQUIRED);
    }

    // checkRevoked is always on (design §3.5), so logout takes effect immediately.
    const decoded = await this.firebaseAuth.verifyIdToken(idToken);
    request.identity = toIdentity(decoded);

    const user = await this.prisma.user.findUnique({ where: { firebaseUid: decoded.uid } });
    if (user) {
      request.user = user;
      return true;
    }

    if (this.hasFlag(context, ALLOW_INCOMPLETE_PROFILE_KEY)) {
      return true;
    }

    // A valid Firebase user without a users row: a Google user who has not chosen a
    // username yet (or a sign-up whose compensating delete failed). 403 rather than 401:
    // the session is fine, so the client must not try a refresh; the code tells it to
    // send the user to profile setup.
    throw new ForbiddenException({ message: PROFILE_SETUP_REQUIRED, code: PROFILE_INCOMPLETE });
  }

  /** A handler-level marker wins over the controller, then the controller is checked. */
  private hasFlag(context: ExecutionContext, key: string): boolean {
    return (
      this.reflector.getAllAndOverride<boolean | undefined>(key, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }
}

/** Keeps only the claims the API uses; the raw token claims are never passed around. */
function toIdentity(decoded: DecodedIdToken): VerifiedIdentity {
  const name: unknown = decoded.name;
  return {
    uid: decoded.uid,
    email: typeof decoded.email === 'string' ? decoded.email : undefined,
    // `name` is an untyped custom claim in DecodedIdToken, so it is narrowed here.
    name: typeof name === 'string' ? name : undefined,
  };
}
