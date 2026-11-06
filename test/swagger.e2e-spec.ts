import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

// The OpenAPI documentation served by the real AppModule (prerequisite: `npm run db:up`).

/** A documented JSON response whose schema is the named component. */
function json(schemaName: string): unknown {
  return {
    content: { 'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } } },
  };
}

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
      '/api/v1/comments/{id}',
      '/api/v1/health',
      '/api/v1/posts',
      '/api/v1/posts/feed',
      '/api/v1/posts/{id}',
      '/api/v1/posts/{id}/comments',
      '/api/v1/posts/{id}/like',
      '/api/v1/posts/{id}/save',
      '/api/v1/uploads',
      '/api/v1/users/me',
      '/api/v1/users/me/saved',
      '/api/v1/users/search',
      '/api/v1/users/{id}/follow',
      '/api/v1/users/{username}',
      '/api/v1/users/{username}/posts',
    ]);
  });

  it('documents the users endpoints with their response types and parameters', () => {
    expect(document).toMatchObject({
      paths: {
        '/api/v1/users/search': {
          get: {
            security: [{ rocky_id: [] }],
            parameters: expect.arrayContaining([
              expect.objectContaining({ name: 'q', in: 'query', required: true }),
              expect.objectContaining({ name: 'filter', in: 'query', required: false }),
              expect.objectContaining({ name: 'cursor', in: 'query', required: false }),
            ]),
            responses: { '200': json('UserSearchPageDto'), '400': json('ErrorResponseDto') },
          },
        },
        '/api/v1/users/{username}': {
          get: {
            responses: { '200': json('ProfileResponseDto'), '404': json('ErrorResponseDto') },
          },
        },
        '/api/v1/users/me': {
          patch: {
            responses: { '200': json('UserResponseDto'), '403': json('ErrorResponseDto') },
          },
        },
        '/api/v1/users/{username}/posts': { get: { responses: { '200': json('PostPageDto') } } },
        '/api/v1/users/me/saved': { get: { responses: { '200': json('PostPageDto') } } },
        '/api/v1/users/{id}/follow': {
          post: { responses: { '200': json('FollowStateDto'), '400': json('ErrorResponseDto') } },
          delete: { responses: { '200': json('FollowStateDto'), '404': json('ErrorResponseDto') } },
        },
      },
    });
  });

  it('documents POST /uploads as a multipart form with a binary file and a purpose', () => {
    expect(document).toMatchObject({
      paths: {
        '/api/v1/uploads': {
          post: {
            security: [{ rocky_id: [] }],
            requestBody: {
              content: {
                'multipart/form-data': {
                  schema: {
                    required: ['file', 'purpose'],
                    properties: {
                      file: { type: 'string', format: 'binary' },
                      purpose: { type: 'string', enum: ['avatar', 'post'] },
                    },
                  },
                },
              },
            },
            responses: {
              '201': {
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/UploadResponseDto' },
                  },
                },
              },
              '413': {
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

  it('documents the posts endpoints with their response types and cursor parameters', () => {
    expect(document).toMatchObject({
      paths: {
        '/api/v1/posts': {
          post: { security: [{ rocky_id: [] }], responses: { '201': json('PostResponseDto') } },
        },
        '/api/v1/posts/feed': {
          get: {
            parameters: expect.arrayContaining([
              expect.objectContaining({ name: 'cursor', in: 'query', required: false }),
              expect.objectContaining({ name: 'limit', in: 'query', required: false }),
            ]),
            responses: { '200': json('PostPageDto'), '400': json('ErrorResponseDto') },
          },
        },
        '/api/v1/posts/{id}': {
          get: { responses: { '200': json('PostResponseDto'), '404': json('ErrorResponseDto') } },
          patch: { responses: { '200': json('PostResponseDto'), '403': json('ErrorResponseDto') } },
          delete: { responses: { '204': expect.any(Object), '403': json('ErrorResponseDto') } },
        },
      },
      components: {
        schemas: {
          PostPageDto: {
            properties: {
              items: { type: 'array', items: { $ref: '#/components/schemas/PostResponseDto' } },
              nextCursor: { type: 'string', nullable: true },
            },
          },
        },
      },
    });
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
