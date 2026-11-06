import { ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { AUTHENTICATION_REQUIRED } from '../../common/guards/firebase-auth.guard';
import {
  FirebaseAuthRestClient,
  type FirebaseSession,
} from '../../firebase/firebase-auth-rest.client';
import { FirebaseAuthService } from '../../firebase/firebase-auth.service';
import {
  EmailAlreadyExistsError,
  FirebaseDomainError,
  type FirebaseErrorCode,
} from '../../firebase/firebase.errors';
import type { User } from '../../generated/prisma/client';
import { isUniqueConstraintViolation } from '../../prisma/prisma-errors';
import { PrismaService } from '../../prisma/prisma.service';
import type { LoginDto } from './dto/login.dto';
import type { SignupDto } from './dto/signup.dto';
import { UserResponseDto } from './dto/user-response.dto';

/** A signed-in user and the tokens the controller puts into cookies. */
export interface AuthResult {
  user: UserResponseDto;
  session: FirebaseSession;
}

export const USERNAME_TAKEN = 'Username is already taken';
export const INVALID_CREDENTIALS = 'Invalid email or password';
export const SESSION_EXPIRED = 'Session expired, please log in again';

/**
 * Refresh failures that mean the session is over: the refresh token is invalid, expired,
 * revoked, or the account is disabled. They end in 401 and cleared cookies. Throttling and
 * Firebase outages are not listed: the session may still be valid, so those keep their
 * own status (429 / 503) and the cookies stay.
 */
const SESSION_ENDING_REFRESH_ERRORS: ReadonlySet<FirebaseErrorCode> = new Set<FirebaseErrorCode>([
  'TOKEN_EXPIRED',
  'TOKEN_REVOKED',
  'INVALID_TOKEN',
  'USER_DISABLED',
  'USER_NOT_FOUND',
]);

/**
 * Sign-up, login, token refresh and logout (design Â§3.3-3.6). Coordinates Firebase (the
 * credentials) and PostgreSQL (the profile). Returns tokens to the controller, which
 * owns the cookies.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly firebaseAuth: FirebaseAuthService,
    private readonly firebaseRest: FirebaseAuthRestClient,
  ) {}

  /**
   * Creates an account (design Â§3.3): checks the username, creates the Firebase user,
   * inserts the users row, then signs the user in.
   *
   * @param dto - Validated and normalised sign-up data.
   * @returns The new user's profile and session tokens.
   * @throws {ConflictException} If the username is taken (also when another sign-up
   *   claims it between the check and the insert).
   * @throws {EmailAlreadyExistsError} If the email is already registered (409).
   * @throws {InvalidEmailError | WeakPasswordError} If Firebase rejects the input (400).
   * @throws {FirebaseDomainError} On other Firebase failures, e.g. unavailable (503).
   */
  async signup(dto: SignupDto): Promise<AuthResult> {
    await this.assertUsernameAvailable(dto.username);

    const { uid } = await this.firebaseAuth.createUser({
      email: dto.email,
      password: dto.password,
      displayName: dto.displayName,
    });

    const user = await this.insertUserOrCompensate(uid, dto);

    // If this sign-in fails, the account still exists and is consistent; the user can
    // log in normally, so nothing is rolled back.
    const session = await this.firebaseRest.signInWithPassword(dto.email, dto.password);
    return { user: UserResponseDto.fromUser(user), session };
  }

  /**
   * Signs a user in with email and password (design Â§3.4).
   *
   * @param dto - Validated and normalised login data.
   * @returns The user's profile and session tokens.
   * @throws {InvalidCredentialsError} If the email or password is wrong (401).
   * @throws {UnauthorizedException} If the Firebase user has no users row.
   * @throws {FirebaseDomainError} On other Firebase failures (403, 429, 503).
   */
  async login(dto: LoginDto): Promise<AuthResult> {
    const session = await this.firebaseRest.signInWithPassword(dto.email, dto.password);

    const user = await this.prisma.user.findUnique({ where: { firebaseUid: session.uid } });
    if (!user) {
      // Only possible if a sign-up's compensating delete failed. Answer like a wrong
      // password, so the response reveals nothing about the account.
      this.logger.warn(`Login for Firebase user ${session.uid}, which has no users row`);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    return { user: UserResponseDto.fromUser(user), session };
  }

  /**
   * Exchanges the refresh token for new tokens (design Â§3.6, FR-AUTH-08).
   *
   * @param refreshToken - The rocky_refresh cookie value, if present.
   * @returns The new session tokens.
   * @throws {UnauthorizedException} If the cookie is missing, or the refresh token is
   *   invalid, expired, revoked or its account disabled: the session is over.
   * @throws {TooManyAttemptsError | FirebaseUnavailableError} If Firebase throttles or is
   *   unreachable (429 / 503); the session may still be valid.
   */
  async refresh(refreshToken: string | undefined): Promise<FirebaseSession> {
    if (!refreshToken) {
      throw new UnauthorizedException(AUTHENTICATION_REQUIRED);
    }

    try {
      return await this.firebaseRest.refreshIdToken(refreshToken);
    } catch (error: unknown) {
      if (error instanceof FirebaseDomainError && SESSION_ENDING_REFRESH_ERRORS.has(error.code)) {
        throw new UnauthorizedException(SESSION_EXPIRED);
      }
      throw error;
    }
  }

  /**
   * Revokes the user's refresh tokens (design Â§3.6, FR-AUTH-06) if the user can be
   * identified from either cookie. Never throws: logout must always succeed so the
   * controller can clear the cookies.
   *
   * @param idToken - The rocky_id cookie value, if present.
   * @param refreshToken - The rocky_refresh cookie value, if present.
   */
  async logout(idToken: string | undefined, refreshToken: string | undefined): Promise<void> {
    const uid = await this.identifyUser(idToken, refreshToken);
    if (!uid) {
      return;
    }

    try {
      await this.firebaseAuth.revokeRefreshTokens(uid);
    } catch (error: unknown) {
      this.logger.warn(`Could not revoke tokens of Firebase user ${uid}: ${errorName(error)}`);
    }
  }

  private async assertUsernameAvailable(username: string): Promise<void> {
    if (await this.isUsernameTaken(username)) {
      throw new ConflictException(USERNAME_TAKEN);
    }
  }

  private async isUsernameTaken(username: string): Promise<boolean> {
    const existing = await this.prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });
    return existing !== null;
  }

  /**
   * Inserts the users row. If that fails, deletes the Firebase user (design Â§3.3,
   * step 5), so no Firebase account is left without a profile.
   */
  private async insertUserOrCompensate(firebaseUid: string, dto: SignupDto): Promise<User> {
    try {
      return await this.prisma.user.create({
        data: {
          firebaseUid,
          email: dto.email,
          username: dto.username,
          displayName: dto.displayName,
        },
      });
    } catch (error: unknown) {
      await this.deleteFirebaseUserAfterFailedSignup(firebaseUid);
      throw await this.toSignupInsertError(error, dto.username);
    }
  }

  /**
   * Translates a failed insert. A unique violation means another sign-up won a race
   * between the availability check and the insert. Which column clashed is found by
   * querying again, rather than parsing Prisma's error metadata, whose shape differs
   * between driver adapters.
   */
  private async toSignupInsertError(error: unknown, username: string): Promise<unknown> {
    if (!isUniqueConstraintViolation(error)) {
      return error;
    }
    if (await this.isUsernameTaken(username)) {
      return new ConflictException(USERNAME_TAKEN);
    }
    // Email is the only other unique column a sign-up can clash on (firebase_uid is new).
    return new EmailAlreadyExistsError();
  }

  private async deleteFirebaseUserAfterFailedSignup(firebaseUid: string): Promise<void> {
    try {
      await this.firebaseAuth.deleteUser(firebaseUid);
    } catch (error: unknown) {
      // The original insert error matters more to the client; this one needs an operator.
      this.logger.error(
        `Compensating delete failed: Firebase user ${firebaseUid} has no users row (${errorName(error)})`,
      );
    }
  }

  /**
   * Finds the uid behind the cookies, using only verified sources: the ID token is
   * verified, and the refresh token is exchanged with Firebase. An unverified JWT is never
   * decoded, as that would let anyone log out any user.
   */
  private async identifyUser(
    idToken: string | undefined,
    refreshToken: string | undefined,
  ): Promise<string | undefined> {
    if (idToken) {
      try {
        return (await this.firebaseAuth.verifyIdToken(idToken)).uid;
      } catch {
        // Expired or already revoked: try the refresh token instead.
      }
    }
    if (refreshToken) {
      try {
        return (await this.firebaseRest.refreshIdToken(refreshToken)).uid;
      } catch {
        // Nothing to revoke: the session is already unusable.
      }
    }
    return undefined;
  }
}

/** A log-safe description of an error: its name only, never its message. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}
