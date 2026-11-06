import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import {
  AUTH_THROTTLE,
  TOO_MANY_REQUESTS_MESSAGE,
} from '../src/common/throttling/throttling.constants';

// Rate limiting with the real AppModule (prerequisite: `npm run db:up`). The login
// requests carry an invalid body: the throttler guard runs before validation, so every
// request still counts, but none of them reaches Firebase.

describe('Rate limiting (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('limits POST /auth/login to the auth limit, then returns the standard 429 body', async () => {
    for (let i = 0; i < AUTH_THROTTLE.limit; i++) {
      await request(app.getHttpServer()).post('/api/v1/auth/login').send({}).expect(400);
    }

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({})
      .expect(429);

    expect(response.body).toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      message: TOO_MANY_REQUESTS_MESSAGE,
      path: '/api/v1/auth/login',
      timestamp: expect.any(String) as unknown,
    });
    expect(response.headers['retry-after']).toBeDefined();
  });

  it('keeps other routes available after the login limit is hit', async () => {
    await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
  });
});
