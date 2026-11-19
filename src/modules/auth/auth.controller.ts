import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiFoundResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  ID_TOKEN_COOKIE,
  OAUTH_COOKIE,
  OAUTH_COOKIE_PATH,
  readCookie,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_COOKIE,
} from '../../common/auth/auth-cookies';
import type { VerifiedIdentity } from '../../common/auth/authenticated-request';
import { AllowIncompleteProfile } from '../../common/decorators/allow-incomplete-profile.decorator';
import { CurrentIdentity } from '../../common/decorators/current-identity.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator';
import { AUTH_THROTTLE, DEFAULT_THROTTLER } from '../../common/throttling/throttling.constants';
import type { User } from '../../generated/prisma/client';
import { AuthCookieService } from './auth-cookie.service';
import { AuthService } from './auth.service';
import { GoogleSignInQueryDto } from './dto/google-sign-in-query.dto';
import { LoginDto } from './dto/login.dto';
import { ProfileSetupResponseDto } from './dto/profile-setup-response.dto';
import { ProfileSetupDto } from './dto/profile-setup.dto';
import { SignupDto } from './dto/signup.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { GoogleCallbackExceptionFilter } from './google/google-callback-exception.filter';
import {
  GOOGLE_ACCOUNT_EXISTS_PATH,
  GOOGLE_SIGN_IN_FAILED_PATH,
  GoogleAuthService,
  WELCOME_PATH,
} from './google/google-auth.service';

/** NFR-SEC-05: stricter per-IP limit for the endpoints that hit Firebase with credentials. */
const AuthThrottle = (): MethodDecorator & ClassDecorator =>
  Throttle({ [DEFAULT_THROTTLER]: AUTH_THROTTLE });

/** OpenAPI description of the Set-Cookie header on responses that start or renew a session. */
const SESSION_COOKIE_HEADERS = {
  'Set-Cookie': {
    description: `Sets the httpOnly session cookies ${ID_TOKEN_COOKIE} (path /) and ${REFRESH_TOKEN_COOKIE} (path ${REFRESH_COOKIE_PATH}).`,
    schema: { type: 'string' },
  },
};

/** OpenAPI description of the Set-Cookie headers of a successful Google callback. */
const GOOGLE_CALLBACK_HEADERS = {
  Location: {
    description: `returnTo for an existing user, ${WELCOME_PATH}?returnTo=... for a new one, ${GOOGLE_SIGN_IN_FAILED_PATH} or ${GOOGLE_ACCOUNT_EXISTS_PATH} on failure.`,
    schema: { type: 'string' },
  },
  'Set-Cookie': {
    description: `Always clears ${OAUTH_COOKIE}. On success also sets ${ID_TOKEN_COOKIE} and ${REFRESH_TOKEN_COOKIE}, exactly like login.`,
    schema: { type: 'string' },
  },
};

/**
 * Auth endpoints (design §5.2). `@Res({ passthrough: true })` gives access to the Express
 * response for cookies while Nest still serialises the return value, like adding a
 * cookie to `HttpServletResponse` and returning a body in Spring.
 */
@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly googleAuth: GoogleAuthService,
    private readonly cookies: AuthCookieService,
  ) {}

  /** Creates an account and signs the user in (FR-AUTH-01, FR-AUTH-02). */
  @Public()
  @AuthThrottle()
  @Post('signup')
  @ApiOperation({ summary: 'Create an account and sign in' })
  @ApiCreatedResponse({
    type: UserResponseDto,
    description: 'Account created; session cookies set.',
    headers: SESSION_COOKIE_HEADERS,
  })
  @ApiErrorResponses(
    HttpStatus.BAD_REQUEST,
    { status: HttpStatus.CONFLICT, description: 'The email or username is already taken.' },
    HttpStatus.TOO_MANY_REQUESTS,
    HttpStatus.SERVICE_UNAVAILABLE,
  )
  async signup(
    @Body() dto: SignupDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<UserResponseDto> {
    const { user, session } = await this.authService.signup(dto);
    this.cookies.setSessionCookies(response, session);
    return user;
  }

  /** Signs a user in with email and password (FR-AUTH-03). */
  @Public()
  @AuthThrottle()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with email and password' })
  @ApiOkResponse({
    type: UserResponseDto,
    description: 'Signed in; session cookies set.',
    headers: SESSION_COOKIE_HEADERS,
  })
  @ApiErrorResponses(
    HttpStatus.BAD_REQUEST,
    { status: HttpStatus.UNAUTHORIZED, description: 'Invalid email or password.' },
    // Not the shared default: login is public, so the guard's PROFILE_INCOMPLETE rule never
    // applies, and a missing users row answers 401 (design §3.5).
    { status: HttpStatus.FORBIDDEN, description: 'The account is disabled.' },
    {
      status: HttpStatus.TOO_MANY_REQUESTS,
      description: 'Rate limit exceeded, or Firebase is blocking further attempts.',
    },
    HttpStatus.SERVICE_UNAVAILABLE,
  )
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<UserResponseDto> {
    const { user, session } = await this.authService.login(dto);
    this.cookies.setSessionCookies(response, session);
    return user;
  }

  /**
   * Issues a new ID token from the refresh cookie (FR-AUTH-08). Public: it is called
   * precisely when the ID token has expired. When the session is over (401), both cookies
   * are cleared so the client stops retrying.
   */
  @Public()
  @AuthThrottle()
  @Post('refresh')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth(REFRESH_TOKEN_COOKIE)
  @ApiOperation({ summary: 'Issue a new ID token from the refresh cookie' })
  @ApiNoContentResponse({
    description: 'Session renewed; cookies set.',
    headers: SESSION_COOKIE_HEADERS,
  })
  @ApiErrorResponses(
    {
      status: HttpStatus.UNAUTHORIZED,
      description:
        'The session is over (missing, invalid, expired or revoked refresh token); both cookies are cleared.',
    },
    HttpStatus.TOO_MANY_REQUESTS,
    HttpStatus.SERVICE_UNAVAILABLE,
  )
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    try {
      const session = await this.authService.refresh(readCookie(request, REFRESH_TOKEN_COOKIE));
      // Both cookies: Firebase may rotate the refresh token too (design §3.6).
      this.cookies.setSessionCookies(response, session);
    } catch (error: unknown) {
      if (error instanceof UnauthorizedException) {
        this.cookies.clearSessionCookies(response);
      }
      throw error;
    }
  }

  /**
   * Revokes the session and clears both cookies (FR-AUTH-06). Public, so it still works
   * when the ID token has already expired; the service identifies the user from either
   * cookie and never throws.
   */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth(ID_TOKEN_COOKIE)
  @ApiCookieAuth(REFRESH_TOKEN_COOKIE)
  @ApiOperation({
    summary: 'Revoke the session and clear the cookies',
    description: 'Works without cookies or with an expired ID token; always succeeds.',
  })
  @ApiNoContentResponse({ description: 'Signed out; both cookies cleared.' })
  @ApiErrorResponses(HttpStatus.TOO_MANY_REQUESTS)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.authService.logout(
      readCookie(request, ID_TOKEN_COOKIE),
      readCookie(request, REFRESH_TOKEN_COOKIE),
    );
    this.cookies.clearSessionCookies(response);
  }

  /**
   * Starts Google sign-in (issue #42, ADR-015): stores the state, PKCE verifier and
   * returnTo in rocky_oauth and redirects the browser to Google's consent screen. Opened
   * by a full-page navigation from rocky-web, never by fetch.
   */
  @Public()
  @AuthThrottle()
  @Get('google')
  @ApiOperation({
    summary: 'Start Google sign-in (browser redirect)',
    description: 'Open in the browser, not with fetch: the response is a redirect to Google.',
  })
  @ApiFoundResponse({
    description: "Redirect to Google's consent screen.",
    headers: {
      Location: { description: 'Google authorization URL.', schema: { type: 'string' } },
      'Set-Cookie': {
        description: `Sets the httpOnly ${OAUTH_COOKIE} cookie (path ${OAUTH_COOKIE_PATH}, 10 minutes).`,
        schema: { type: 'string' },
      },
    },
  })
  @ApiErrorResponses(HttpStatus.BAD_REQUEST, HttpStatus.TOO_MANY_REQUESTS)
  startGoogleSignIn(@Query() query: GoogleSignInQueryDto, @Res() response: Response): void {
    const { authorizationUrl, oauthCookie } = this.googleAuth.startSignIn(query.returnTo);
    this.cookies.setOAuthCookie(response, oauthCookie);
    response.redirect(HttpStatus.FOUND, authorizationUrl);
  }

  /**
   * Google's redirect back after the consent screen (issue #42). Always answers with a
   * redirect, never JSON: on success it sets the session cookies like login; every failure,
   * including a cancelled consent, ends on the login page. Only `code`, `state` and
   * `error` are read, as raw values, so the other parameters Google adds are ignored
   * instead of failing validation; the service checks the values.
   */
  @Public()
  @AuthThrottle()
  @Get('google/callback')
  @UseFilters(GoogleCallbackExceptionFilter)
  @ApiOperation({
    summary: 'Google OAuth callback (browser redirect)',
    description:
      'Called by Google, not by clients. Any other query parameters are ignored. Errors, ' +
      'including rate limiting, are redirects to the login page, never JSON.',
  })
  @ApiQuery({ name: 'code', required: false, description: 'Authorization code from Google.' })
  @ApiQuery({ name: 'state', required: false, description: 'Must match the rocky_oauth cookie.' })
  @ApiQuery({ name: 'error', required: false, description: 'Set by Google, e.g. access_denied.' })
  @ApiFoundResponse({ description: 'Redirect into rocky-web.', headers: GOOGLE_CALLBACK_HEADERS })
  async googleCallback(
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @Query('error') error: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const outcome = await this.googleAuth.completeSignIn(
      { code, state, error },
      readCookie(request, OAUTH_COOKIE),
    );
    // One attempt, one use: the state and verifier are gone whatever the outcome.
    this.cookies.clearOAuthCookie(response);
    if (outcome.session) {
      this.cookies.setSessionCookies(response, outcome.session);
    }
    response.redirect(HttpStatus.FOUND, outcome.redirectPath);
  }

  /**
   * Prefills the /welcome form of a signed-in user who has no profile yet, typically a new
   * Google user (FR-AUTH-10). `@AllowIncompleteProfile()` lets the request past the
   * PROFILE_INCOMPLETE rule; the token is still required.
   */
  @AllowIncompleteProfile()
  @AuthThrottle()
  @Get('profile-setup')
  @ApiCookieAuth(ID_TOKEN_COOKIE)
  @ApiOperation({ summary: 'Suggested values for completing a new profile' })
  @ApiOkResponse({ type: ProfileSetupResponseDto })
  @ApiErrorResponses(
    { status: HttpStatus.BAD_REQUEST, description: 'The account has no email address.' },
    HttpStatus.UNAUTHORIZED,
    { status: HttpStatus.CONFLICT, description: 'The profile already exists.' },
    HttpStatus.TOO_MANY_REQUESTS,
    HttpStatus.SERVICE_UNAVAILABLE,
  )
  getProfileSetup(@CurrentIdentity() identity: VerifiedIdentity): Promise<ProfileSetupResponseDto> {
    return this.authService.getProfileSetup(identity);
  }

  /**
   * Creates the profile of a signed-in user who has none yet (FR-AUTH-10), with the same
   * username and display name rules as sign-up. Afterwards every endpoint works normally;
   * the session cookies stay as they are.
   */
  @AllowIncompleteProfile()
  @AuthThrottle()
  @Post('profile-setup')
  @ApiCookieAuth(ID_TOKEN_COOKIE)
  @ApiOperation({ summary: 'Complete a new profile (choose a username)' })
  @ApiCreatedResponse({ type: UserResponseDto, description: 'Profile created.' })
  @ApiErrorResponses(
    {
      status: HttpStatus.BAD_REQUEST,
      description: 'Invalid or reserved username, invalid display name, or no account email.',
    },
    HttpStatus.UNAUTHORIZED,
    {
      status: HttpStatus.CONFLICT,
      description: 'The profile already exists, or the username or email is taken.',
    },
    HttpStatus.TOO_MANY_REQUESTS,
    HttpStatus.SERVICE_UNAVAILABLE,
  )
  completeProfileSetup(
    @CurrentIdentity() identity: VerifiedIdentity,
    @Body() dto: ProfileSetupDto,
  ): Promise<UserResponseDto> {
    return this.authService.completeProfileSetup(identity, dto);
  }

  /** Returns the signed-in user's profile and settings. */
  @Get('me')
  @ApiCookieAuth(ID_TOKEN_COOKIE)
  @ApiOperation({ summary: "The signed-in user's profile and settings" })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiErrorResponses(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.TOO_MANY_REQUESTS,
    HttpStatus.SERVICE_UNAVAILABLE,
  )
  me(@CurrentUser() user: User): UserResponseDto {
    return UserResponseDto.fromUser(user);
  }
}
