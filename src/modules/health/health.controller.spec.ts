import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../../app.setup';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

// HTTP-level tests with HealthService mocked: real routing, prefix and exception filter,
// but no database. No auth guard is registered, so @Public() is covered by the e2e test.

describe('HealthController (HTTP)', () => {
  const healthService = { isDatabaseUp: jest.fn() };
  let app: NestExpressApplication;

  beforeEach(async () => {
    jest.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: HealthService, useValue: healthService }],
    }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 { status: ok, database: up } when the database answers', async () => {
    healthService.isDatabaseUp.mockResolvedValue(true);

    const response = await request(app.getHttpServer()).get('/api/v1/health').expect(200);

    expect(response.body).toEqual({ status: 'ok', database: 'up' });
  });

  it('returns 503 { status: error, database: down } when the database is down', async () => {
    healthService.isDatabaseUp.mockResolvedValue(false);

    const response = await request(app.getHttpServer()).get('/api/v1/health').expect(503);

    // The health body, not the standard error body.
    expect(response.body).toEqual({ status: 'error', database: 'down' });
  });
});
