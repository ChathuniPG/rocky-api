import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

// Boots the real AppModule against the local database (prerequisite: `npm run db:up`).
// GET /health runs SELECT 1 only, so it reads and writes no data.

describe('Health check (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('is public and reports the database as up', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health').expect(200);

    expect(response.body).toEqual({ status: 'ok', database: 'up' });
  });

  it('sends the Helmet security headers', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toEqual(expect.any(String));
    expect(response.headers).not.toHaveProperty('x-powered-by');
  });
});
