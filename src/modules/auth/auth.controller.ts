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
import type { Request, Response } from 'express';
import { ID_TOKEN_COOKIE, readCookie, REFRESH_TOKEN_COOKIE } from '../../common/auth/auth-cookies';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { User } from '../../generated/prisma/client';
import { AuthCookieService } from './auth-cookie.service';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { UserResponseDto } from './dto/user-response.dto';

/**
 * Auth endpoints (design §5.2). `@Res({ passthrough: true })` gives access to the Express
 * response for cookies while Nest still serialises the return value, like adding a
 * cookie to `HttpServletResponse` and returning a body in Spring.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly cookies: AuthCookieService,
  ) {}

  /** Creates an account and signs the user in (FR-AUTH-01, FR-AUTH-02). */
  @Public()
  @Post('signup')
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
  @Post('login')
  @HttpCode(HttpStatus.OK)
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
  @Post('refresh')
  @HttpCode(HttpStatus.NO_CONTENT)
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
  me(@CurrentUser() user: User): UserResponseDto {
    return UserResponseDto.fromUser(user);
  }
}
