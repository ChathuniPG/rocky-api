import type { Request } from 'express';
import type { User } from '../../generated/prisma/client';

/**
 * A request that passed `FirebaseAuthGuard`: `user` is the signed-in user's row from
 * PostgreSQL (design §3.5). Only valid on routes that are not `@Public()`.
 */
export interface AuthenticatedRequest extends Request {
  user: User;
}
