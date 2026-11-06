/**
 * Domain errors raised by the Firebase module.
 *
 * The Firebase module never throws HTTP exceptions: it translates Firebase error codes
 * (Admin SDK and Auth REST API) into these classes, and the auth module (#4) maps them to
 * HTTP responses. Messages are fixed, safe strings: they never contain tokens, emails,
 * passwords or raw Firebase messages, so they can be logged without leaking anything.
 */

/** Stable identifiers for every domain error, usable in an exhaustive `switch`. */
export type FirebaseErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'EMAIL_ALREADY_EXISTS'
  | 'INVALID_EMAIL'
  | 'WEAK_PASSWORD'
  | 'USER_NOT_FOUND'
  | 'USER_DISABLED'
  | 'TOO_MANY_ATTEMPTS'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_REVOKED'
  | 'INVALID_TOKEN'
  | 'FIREBASE_UNAVAILABLE';

/**
 * Base class of every Firebase domain error. Catch it to handle any Firebase failure, or
 * switch on `code` to handle each case.
 */
export abstract class FirebaseDomainError extends Error {
  /** Stable identifier of the failure. */
  abstract readonly code: FirebaseErrorCode;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    // `new.target` is the concrete subclass, so stack traces and logs show e.g.
    // "TokenRevokedError" instead of "Error".
    this.name = new.target.name;
  }
}

/** Email or password is wrong, or no account exists. Deliberately one error (design §3.4). */
export class InvalidCredentialsError extends FirebaseDomainError {
  readonly code = 'INVALID_CREDENTIALS';

  constructor() {
    super('Invalid email or password');
  }
}

/** Another account already uses this email address. */
export class EmailAlreadyExistsError extends FirebaseDomainError {
  readonly code = 'EMAIL_ALREADY_EXISTS';

  constructor() {
    super('The email address is already in use');
  }
}

/** Firebase rejected the email address as malformed. */
export class InvalidEmailError extends FirebaseDomainError {
  readonly code = 'INVALID_EMAIL';

  constructor() {
    super('The email address is invalid');
  }
}

/** Firebase rejected the password as too weak. */
export class WeakPasswordError extends FirebaseDomainError {
  readonly code = 'WEAK_PASSWORD';

  constructor() {
    super('The password does not meet the password requirements');
  }
}

/** No Firebase user exists for the given UID. */
export class UserNotFoundError extends FirebaseDomainError {
  readonly code = 'USER_NOT_FOUND';

  constructor() {
    super('The user does not exist');
  }
}

/** The Firebase account has been disabled by an administrator. */
export class UserDisabledError extends FirebaseDomainError {
  readonly code = 'USER_DISABLED';

  constructor() {
    super('The user account is disabled');
  }
}

/** Firebase is throttling sign-in attempts for this account or client. */
export class TooManyAttemptsError extends FirebaseDomainError {
  readonly code = 'TOO_MANY_ATTEMPTS';

  constructor() {
    super('Too many attempts, try again later');
  }
}

/** The ID token, or the credential behind a refresh token, has expired. */
export class TokenExpiredError extends FirebaseDomainError {
  readonly code = 'TOKEN_EXPIRED';

  constructor() {
    super('The token has expired');
  }
}

/** The token was revoked (e.g. by logout), so the user must sign in again. */
export class TokenRevokedError extends FirebaseDomainError {
  readonly code = 'TOKEN_REVOKED';

  constructor() {
    super('The token has been revoked');
  }
}

/** The token is malformed, has a bad signature, or belongs to another project or user. */
export class InvalidTokenError extends FirebaseDomainError {
  readonly code = 'INVALID_TOKEN';

  constructor() {
    super('The token is invalid');
  }
}

/**
 * Firebase could not be reached, timed out, answered with an unexpected error code or
 * returned a malformed response. `cause` keeps the original error for server-side
 * logging; it must never be sent to clients.
 */
export class FirebaseUnavailableError extends FirebaseDomainError {
  readonly code = 'FIREBASE_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Firebase request failed', options);
  }
}
