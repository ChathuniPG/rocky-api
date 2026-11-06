import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  ID_TOKEN_COOKIE,
  readCookie,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_COOKIE,
} from '../../common/auth/auth-cookies';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator';
import { AUTH_THROTTLE, DEFAULT_THROTTLER } from '../../common/throttling/throttling.constants';
import type { User } from '../../generated/prisma/client';
import { AuthCookieService } from './auth-cookie.service';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { UserResponseDto } from './dto/user-response.dto';

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
    HttpStatus.FORBIDDEN,
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
