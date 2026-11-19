import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Test } from '@nestjs/testing';
import { buildUser } from '../../../test/fixtures/user.fixture';
import { FirebaseAuthService } from '../../firebase/firebase-auth.service';
import { TokenRevokedError } from '../../firebase/firebase.errors';
import type { User } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { VerifiedIdentity } from '../auth/authenticated-request';
import { AllowIncompleteProfile } from '../decorators/allow-incomplete-profile.decorator';
import { Public } from '../decorators/public.decorator';
import {
  FirebaseAuthGuard,
  PROFILE_INCOMPLETE,
  PROFILE_SETUP_REQUIRED,
} from './firebase-auth.guard';

const ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.fake-id-token.fake-signature';
const FIREBASE_UID = 'firebase-uid-123';
const DECODED = { uid: FIREBASE_UID, email: 'alice@example.com', name: 'Alice Example' };

const user = buildUser({ firebaseUid: FIREBASE_UID });

// Controllers and handlers used only as metadata targets for the Reflector. `this: void`
// tells TypeScript the handlers never use `this`, so passing them around is safe.
class PrivateController {
  handler(this: void): void {}
}

@Public()
class PublicController {
  handler(this: void): void {}
}

class MixedController {
  @Public()
  publicHandler(this: void): void {}

  @AllowIncompleteProfile()
  setupHandler(this: void): void {}
}

interface FakeRequest {
  cookies: Record<string, unknown>;
  identity?: VerifiedIdentity;
  user?: User;
}

/** Builds a real Nest HTTP execution context for one handler and request. */
function contextFor(
  controller: new () => object,
  handler: (this: void) => void,
  cookies: Record<string, unknown> = {},
): { context: ExecutionContextHost; request: FakeRequest } {
  const request: FakeRequest = { cookies };
  const context = new ExecutionContextHost([request, {}], controller, handler);
  return { context, request };
}

describe('FirebaseAuthGuard', () => {
  const verifyIdToken = jest.fn();
  const findUnique = jest.fn();
  let guard: FirebaseAuthGuard;

  beforeEach(async () => {
    jest.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        FirebaseAuthGuard,
        { provide: FirebaseAuthService, useValue: { verifyIdToken } },
        { provide: PrismaService, useValue: { user: { findUnique } } },
      ],
    }).compile();
    guard = moduleRef.get(FirebaseAuthGuard);
  });

  describe('public routes', () => {
    it('allows a @Public() controller without a cookie', async () => {
      const { context } = contextFor(PublicController, PublicController.prototype.handler);

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(verifyIdToken).not.toHaveBeenCalled();
    });

    it('allows a @Public() handler without a cookie', async () => {
      const { context } = contextFor(MixedController, MixedController.prototype.publicHandler);

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(verifyIdToken).not.toHaveBeenCalled();
    });
  });

  describe('protected routes', () => {
    it('rejects a request without the rocky_id cookie', async () => {
      const { context } = contextFor(PrivateController, PrivateController.prototype.handler);

      await expect(guard.canActivate(context)).rejects.toThrow(
        new UnauthorizedException('Authentication required'),
      );
      expect(verifyIdToken).not.toHaveBeenCalled();
    });

    it('rejects an empty rocky_id cookie', async () => {
      const { context } = contextFor(PrivateController, PrivateController.prototype.handler, {
        rocky_id: '',
      });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      expect(verifyIdToken).not.toHaveBeenCalled();
    });

    it('propagates token verification errors to the exception filter', async () => {
      verifyIdToken.mockRejectedValue(new TokenRevokedError());
      const { context } = contextFor(PrivateController, PrivateController.prototype.handler, {
        rocky_id: ID_TOKEN,
      });

      await expect(guard.canActivate(context)).rejects.toThrow(TokenRevokedError);
      expect(findUnique).not.toHaveBeenCalled();
    });

    it('rejects a valid token without a users row with 403 PROFILE_INCOMPLETE', async () => {
      verifyIdToken.mockResolvedValue(DECODED);
      findUnique.mockResolvedValue(null);
      const { context, request } = contextFor(
        PrivateController,
        PrivateController.prototype.handler,
        { rocky_id: ID_TOKEN },
      );

      const error: unknown = await guard.canActivate(context).catch((caught: unknown) => caught);

      if (!(error instanceof ForbiddenException)) {
        throw new Error('Expected a ForbiddenException');
      }
      expect(error.getResponse()).toEqual({
        message: PROFILE_SETUP_REQUIRED,
        code: PROFILE_INCOMPLETE,
      });
      expect(request.user).toBeUndefined();
    });

    it('verifies the token, loads the user and attaches the user and identity', async () => {
      verifyIdToken.mockResolvedValue(DECODED);
      findUnique.mockResolvedValue(user);
      const { context, request } = contextFor(
        PrivateController,
        PrivateController.prototype.handler,
        { rocky_id: ID_TOKEN },
      );

      await expect(guard.canActivate(context)).resolves.toBe(true);

      expect(verifyIdToken).toHaveBeenCalledWith(ID_TOKEN);
      expect(findUnique).toHaveBeenCalledWith({ where: { firebaseUid: FIREBASE_UID } });
      expect(request.user).toBe(user);
      expect(request.identity).toEqual(DECODED);
    });
  });

  describe('@AllowIncompleteProfile() routes', () => {
    it('admits a valid token without a users row and attaches only the identity', async () => {
      verifyIdToken.mockResolvedValue(DECODED);
      findUnique.mockResolvedValue(null);
      const { context, request } = contextFor(
        MixedController,
        MixedController.prototype.setupHandler,
        { rocky_id: ID_TOKEN },
      );

      await expect(guard.canActivate(context)).resolves.toBe(true);

      expect(request.identity).toEqual(DECODED);
      expect(request.user).toBeUndefined();
    });

    it('still attaches the user when the profile exists', async () => {
      verifyIdToken.mockResolvedValue(DECODED);
      findUnique.mockResolvedValue(user);
      const { context, request } = contextFor(
        MixedController,
        MixedController.prototype.setupHandler,
        { rocky_id: ID_TOKEN },
      );

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(request.user).toBe(user);
    });

    it('still requires the rocky_id cookie', async () => {
      const { context } = contextFor(MixedController, MixedController.prototype.setupHandler);

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('keeps only string email and name claims', async () => {
      verifyIdToken.mockResolvedValue({ uid: FIREBASE_UID, name: 42 });
      findUnique.mockResolvedValue(null);
      const { context, request } = contextFor(
        MixedController,
        MixedController.prototype.setupHandler,
        { rocky_id: ID_TOKEN },
      );

      await guard.canActivate(context);

      expect(request.identity).toEqual({ uid: FIREBASE_UID, email: undefined, name: undefined });
    });
  });
});
