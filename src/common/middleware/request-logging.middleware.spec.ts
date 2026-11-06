import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import { createRequestLoggingMiddleware } from './request-logging.middleware';

// HTTP-level tests: a small Nest app with the middleware and a few stub routes, so the
// middleware sees real Express requests and responses.

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.secret-token';
const USER_ID = 'user-uuid-1';

let healthUp = true;

@Controller()
class StubController {
  @Get('ok')
  ok(): { ok: true } {
    return { ok: true };
  }

  @Post('login')
  login(): { ok: true } {
    return { ok: true };
  }

  @Get('me')
  me(): { ok: true } {
    return { ok: true };
  }

  @Get('missing')
  missing(): never {
    throw new NotFoundException();
  }

  @Get('broken')
  broken(): never {
    throw new InternalServerErrorException();
  }

  @Get('health')
  health(): { status: string } {
    if (!healthUp) {
      throw new ServiceUnavailableException();
    }
    return { status: 'ok' };
  }
}

/** Stands in for FirebaseAuthGuard: authenticates requests to /me only. */
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const httpRequest = context.switchToHttp().getRequest<Request & { user?: { id: string } }>();
    if (httpRequest.path === '/me') {
      httpRequest.user = { id: USER_ID };
    }
    return true;
  }
}

describe('createRequestLoggingMiddleware', () => {
  let app: NestExpressApplication;
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(async () => {
    healthUp = true;
    const logger = new Logger('HTTP');
    log = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);

    const moduleRef = await Test.createTestingModule({
      controllers: [StubController],
      providers: [{ provide: APP_GUARD, useClass: FakeAuthGuard }],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    app.use(createRequestLoggingMiddleware({ logger, quietPaths: ['/health'] }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  /** Every line written at any level. */
  function allLogLines(): string {
    return JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls]);
  }

  /**
   * Waits until the expected number of lines is logged: the middleware logs on the
   * response's 'close' event, which can fire just after supertest resolves.
   */
  async function waitForLogLines(count: number): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const total = log.mock.calls.length + warn.mock.calls.length + error.mock.calls.length;
      if (total >= count) {
        return;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  it('logs method, path, status and duration', async () => {
    await request(app.getHttpServer()).post('/login').send({ password: TOKEN }).expect(201);
    await waitForLogLines(1);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^POST \/login 201 \d+\.\dms$/));
  });

  it('adds the user id when the request is authenticated', async () => {
    await request(app.getHttpServer()).get('/me').expect(200);
    await waitForLogLines(1);

    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^GET \/me 200 \d+\.\dms user=user-uuid-1$/),
    );
  });

  it('drops the query string', async () => {
    await request(app.getHttpServer()).get('/ok?q=alice&token=x').expect(200);
    await waitForLogLines(1);

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^GET \/ok 200 /));
    expect(allLogLines()).not.toContain('alice');
  });

  it('logs 4xx at warn level, including unknown routes', async () => {
    await request(app.getHttpServer()).get('/missing').expect(404);
    await request(app.getHttpServer()).get('/no-such-route').expect(404);
    await waitForLogLines(2);

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^GET \/missing 404 /));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^GET \/no-such-route 404 /));
    expect(log).not.toHaveBeenCalled();
  });

  it('logs 5xx at error level', async () => {
    await request(app.getHttpServer()).get('/broken').expect(500);
    await waitForLogLines(1);

    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^GET \/broken 500 /));
  });

  it('skips successful requests to quiet paths but logs their failures', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
    healthUp = false;
    await request(app.getHttpServer()).get('/health').expect(503);
    await waitForLogLines(1);

    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^GET \/health 503 /));
  });

  it('never logs cookies, headers, bodies or tokens', async () => {
    await request(app.getHttpServer())
      .post('/login')
      .set('Cookie', `rocky_id=${TOKEN}`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ password: TOKEN });
    await request(app.getHttpServer()).get('/me').set('Cookie', `rocky_id=${TOKEN}`);
    await waitForLogLines(2);

    expect(allLogLines()).not.toContain(TOKEN);
    expect(allLogLines()).not.toContain('rocky_id');
  });
});
