import { UnauthorizedException } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Test } from '@nestjs/testing';
import { buildUser } from '../../../test/fixtures/user.fixture';
import { FirebaseAuthService } from '../../firebase/firebase-auth.service';
import { TokenRevokedError } from '../../firebase/firebase.errors';
import type { User } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Public } from '../decorators/public.decorator';
import { FirebaseAuthGuard } from './firebase-auth.guard';

const ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.fake-id-token.fake-signature';
const FIREBASE_UID = 'firebase-uid-123';

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
}

interface FakeRequest {
  cookies: Record<string, unknown>;
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

    it('rejects a valid token whose user has no database row', async () => {
      verifyIdToken.mockResolvedValue({ uid: FIREBASE_UID });
      findUnique.mockResolvedValue(null);
      const { context, request } = contextFor(
        PrivateController,
        PrivateController.prototype.handler,
        { rocky_id: ID_TOKEN },
      );

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      expect(request.user).toBeUndefined();
    });

    it('verifies the token, loads the user and attaches it to the request', async () => {
      verifyIdToken.mockResolvedValue({ uid: FIREBASE_UID });
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
    });
  });
});
