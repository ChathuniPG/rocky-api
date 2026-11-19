import { Controller, Get, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import request from 'supertest';
import { findSetCookie } from '../../../test/helpers/cookies';
import { AuthCookieService } from './auth-cookie.service';

// HTTP-level tests: a stub controller calls the service, so the assertions see the real
// Set-Cookie headers Express writes.

@Controller()
class StubController {
  constructor(private readonly cookies: AuthCookieService) {}

  @Get('set-oauth')
  setOAuth(@Res({ passthrough: true }) response: Response): void {
    this.cookies.setOAuthCookie(response, '{"state":"s"}');
  }

  @Get('clear-oauth')
  clearOAuth(@Res({ passthrough: true }) response: Response): void {
    this.cookies.clearOAuthCookie(response);
  }
}

async function startApp(cookieSecure: boolean): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [StubController],
    providers: [
      AuthCookieService,
      { provide: ConfigService, useValue: { get: () => cookieSecure } },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  await app.init();
  return app;
}

describe('AuthCookieService (rocky_oauth)', () => {
  let app: NestExpressApplication;

  afterEach(async () => {
    await app.close();
  });

  it('sets rocky_oauth httpOnly, Secure, SameSite=Lax, on the Google routes only, for 10 minutes', async () => {
    app = await startApp(true);

    const response = await request(app.getHttpServer()).get('/set-oauth').expect(200);

    const header = findSetCookie(response, 'rocky_oauth') ?? '';
    expect(header).toContain(`rocky_oauth=${encodeURIComponent('{"state":"s"}')}`);
    expect(header).toContain('Path=/api/v1/auth/google;');
    expect(header).toContain('Max-Age=600;');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
  });

  it('omits Secure when COOKIE_SECURE is false', async () => {
    app = await startApp(false);

    const response = await request(app.getHttpServer()).get('/set-oauth').expect(200);

    expect(findSetCookie(response, 'rocky_oauth')).not.toContain('Secure');
  });

  it('clears rocky_oauth with the same path it was set with', async () => {
    app = await startApp(true);

    const response = await request(app.getHttpServer()).get('/clear-oauth').expect(200);

    const header = findSetCookie(response, 'rocky_oauth') ?? '';
    expect(header).toMatch(/^rocky_oauth=;/);
    expect(header).toContain('Path=/api/v1/auth/google;');
    expect(header).toContain('Expires=Thu, 01 Jan 1970');
  });
});
