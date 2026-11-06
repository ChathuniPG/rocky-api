import { Controller, Get } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { SkipThrottle, Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { configureApp } from '../../app.setup';
import { DEFAULT_THROTTLER, TOO_MANY_REQUESTS_MESSAGE } from './throttling.constants';

// HTTP-level tests of the throttling setup used in AppModule, with small limits so each
// test needs only a few requests: global default, per-route override, opt-out, and the
// standard error body on 429.

const DEFAULT_LIMIT = 3;
const STRICT_LIMIT = 1;

@Controller('stub')
class StubController {
  @Get('default')
  byDefault(): { ok: true } {
    return { ok: true };
  }

  @Throttle({ [DEFAULT_THROTTLER]: { ttl: 60_000, limit: STRICT_LIMIT } })
  @Get('strict')
  strict(): { ok: true } {
    return { ok: true };
  }

  @SkipThrottle()
  @Get('unlimited')
  unlimited(): { ok: true } {
    return { ok: true };
  }
}

describe('Rate limiting', () => {
  let app: NestExpressApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [{ name: DEFAULT_THROTTLER, ttl: 60_000, limit: DEFAULT_LIMIT }],
          errorMessage: TOO_MANY_REQUESTS_MESSAGE,
        }),
      ],
      controllers: [StubController],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  /** Sends `count` GET requests one after another and returns their statuses. */
  async function statuses(path: string, count: number): Promise<number[]> {
    const result: number[] = [];
    for (let i = 0; i < count; i++) {
      const response = await request(app.getHttpServer()).get(path);
      result.push(response.status);
    }
    return result;
  }

  /** Sends one GET /stub/default as if forwarded by Nginx for `clientIp`; returns the status. */
  async function statusFor(clientIp: string): Promise<number> {
    const response = await request(app.getHttpServer())
      .get('/api/v1/stub/default')
      .set('X-Forwarded-For', clientIp);
    return response.status;
  }

  it('allows requests up to the default limit, then returns 429', async () => {
    await expect(statuses('/api/v1/stub/default', DEFAULT_LIMIT + 1)).resolves.toEqual([
      200, 200, 200, 429,
    ]);
  });

  it('returns the standard error body and a Retry-After header on 429', async () => {
    await statuses('/api/v1/stub/default', DEFAULT_LIMIT);

    const response = await request(app.getHttpServer()).get('/api/v1/stub/default').expect(429);

    expect(response.body).toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      message: TOO_MANY_REQUESTS_MESSAGE,
      path: '/api/v1/stub/default',
      timestamp: expect.any(String) as unknown,
    });
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('applies a stricter per-route limit set with @Throttle', async () => {
    await expect(statuses('/api/v1/stub/strict', STRICT_LIMIT + 1)).resolves.toEqual([200, 429]);
  });

  it('counts each route separately', async () => {
    await statuses('/api/v1/stub/strict', STRICT_LIMIT + 1);

    const response = await request(app.getHttpServer()).get('/api/v1/stub/default');
    expect(response.status).toBe(200);
  });

  it('never limits a route marked @SkipThrottle', async () => {
    const results = await statuses('/api/v1/stub/unlimited', DEFAULT_LIMIT + 3);

    expect(results.every((status) => status === 200)).toBe(true);
  });

  it('tracks clients by their forwarded IP when the request comes through a loopback proxy', async () => {
    // Trust proxy is "loopback", so X-Forwarded-For is honoured only when the connection
    // comes from the same host (Nginx). supertest connects from loopback, so it plays
    // Nginx here: two forwarded IPs get separate counters, like two real clients. A
    // direct connection from another host cannot be simulated with supertest.
    for (let i = 0; i < DEFAULT_LIMIT; i++) {
      await statusFor('203.0.113.1');
    }

    await expect(statusFor('203.0.113.1')).resolves.toBe(429);
    await expect(statusFor('203.0.113.2')).resolves.toBe(200);
  });
});
