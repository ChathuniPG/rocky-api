import type { Request } from 'express';
import type { User } from '../../generated/prisma/client';

/**
 * The Firebase identity behind a verified ID token, taken from its claims. It exists even
 * when the user has no users row yet (a new Google user before profile setup).
 */
export interface VerifiedIdentity {
  /** Firebase UID. */
  uid: string;
  /** Email claim of the token, if the account has one. */
  email: string | undefined;
  /** Name claim of the token (e.g. the Google account name), if present. */
  name: string | undefined;
}

/**
 * A request whose ID token `FirebaseAuthGuard` verified: `identity` is always set. Only
 * valid on routes that are not `@Public()`.
 */
export interface IdentifiedRequest extends Request {
  identity: VerifiedIdentity;
}

/**
 * A request that passed `FirebaseAuthGuard` with a complete profile: `user` is the
 * signed-in user's row from PostgreSQL (design §3.5). Valid on every route that is neither
 * `@Public()` nor `@AllowIncompleteProfile()`.
 */
export interface AuthenticatedRequest extends IdentifiedRequest {
  user: User;
}
