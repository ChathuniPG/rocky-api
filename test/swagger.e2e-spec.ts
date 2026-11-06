import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

// The OpenAPI documentation served by the real AppModule (prerequisite: `npm run db:up`).

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

describe('Swagger (e2e)', () => {
  let app: NestExpressApplication;
  let document: unknown;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();

    const response = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    document = response.body;
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the Swagger UI page with a CSP that allows it to load', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/docs')
      .set('Accept', 'text/html')
      .redirects(1)
      .expect(200);

    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.text).toContain('swagger-ui-bundle.js');
    // Helmet's CSP blocks inline scripts; the UI must use external ones only.
    expect(response.text).not.toMatch(/<script>(?!\s*<\/script>)/);
    const csp = response.headers['content-security-policy'];
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it.each([
    ['swagger-ui-bundle.js', /javascript/],
    ['swagger-ui-init.js', /javascript/],
    ['swagger-ui.css', /text\/css/],
  ])('serves the UI asset %s', async (asset, contentType) => {
    const response = await request(app.getHttpServer()).get(`/api/docs/${asset}`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(contentType);
  });

  it('documents every existing endpoint under /api/v1', () => {
    const paths = isRecord(document) && isRecord(document.paths) ? document.paths : {};

    expect(Object.keys(paths).toSorted()).toEqual([
      '/api/v1/auth/login',
      '/api/v1/auth/logout',
      '/api/v1/auth/me',
      '/api/v1/auth/refresh',
      '/api/v1/auth/signup',
      '/api/v1/health',
    ]);
  });

  it('declares cookie authentication for both session cookies', () => {
    expect(document).toMatchObject({
      components: {
        securitySchemes: {
          rocky_id: { type: 'apiKey', in: 'cookie', name: 'rocky_id' },
          rocky_refresh: { type: 'apiKey', in: 'cookie', name: 'rocky_refresh' },
        },
      },
      paths: { '/api/v1/auth/me': { get: { security: [{ rocky_id: [] }] } } },
    });
  });

  it('documents the standard error body on error responses', () => {
    expect(document).toMatchObject({
      paths: {
        '/api/v1/auth/login': {
          post: {
            responses: {
              '429': {
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/ErrorResponseDto' },
                  },
                },
              },
            },
          },
        },
      },
    });
  });
});
