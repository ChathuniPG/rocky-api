import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

// Boots the real AppModule, including PrismaModule, which connects to PostgreSQL at
// startup. Prerequisites: `npm run db:up` and DATABASE_URL in .env. This test makes
// no queries, so it reads and writes no data.

describe('Application bootstrap (e2e)', () => {
  let app: NestExpressApplication;

  beforeEach(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = configureApp(moduleFixture.createNestApplication<NestExpressApplication>());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('boots the full module graph and returns a JSON 404 for an unknown route', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/does-not-exist').expect(404);

    // The global exception filter's body (design §5.1).
    expect(response.body).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: expect.any(String) as unknown,
      path: '/api/v1/does-not-exist',
      timestamp: expect.any(String) as unknown,
    });
  });
});
