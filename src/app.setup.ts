import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { ID_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from './common/auth/auth-cookies';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { API_PREFIX } from './common/http/api-prefix.constants';
import { createRequestLoggingMiddleware } from './common/middleware/request-logging.middleware';

// Re-exported so existing imports (main.ts, tests) keep working.
export { API_PREFIX };

/** Full path of the health check, used to keep successful probes out of the request log. */
export const HEALTH_CHECK_PATH = `/${API_PREFIX}/health`;

/** Swagger UI (design §5.1). Outside the /api/v1 prefix: it documents the API, it is not part of it. */
export const SWAGGER_UI_PATH = 'api/docs';

/** The raw OpenAPI document, for client generators and tests. */
export const SWAGGER_JSON_PATH = 'api/docs-json';

/**
 * Applies the app-wide HTTP settings shared by `main.ts` and the e2e tests, so tests
 * exercise exactly the same setup as production.
 *
 * The global guards are not registered here: they need dependency injection, so they are
 * provided with `APP_GUARD` in `AppModule`, which the e2e tests import too.
 *
 * @param app - The Nest Express application to configure, before it starts listening.
 * @returns The same application, for chaining.
 */
export function configureApp<T extends NestExpressApplication>(app: T): T {
  app.setGlobalPrefix(API_PREFIX);

  // The app runs behind Nginx on the same host (ADR-004). Trusting only loopback makes
  // req.ip the real client address from X-Forwarded-For when the request comes through
  // Nginx, while a client connecting directly cannot spoof its IP with that header. `true`
  // would trust any X-Forwarded-For and let a client dodge per-IP rate limits (NFR-SEC-05).
  app.set('trust proxy', 'loopback');

  // NFR-OPS-04: registered first, so it also times and logs requests that guards,
  // Helmet or the router reject.
  app.use(createRequestLoggingMiddleware({ quietPaths: [HEALTH_CHECK_PATH] }));

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // Helmet's default CSP already suits Swagger UI: its scripts are external
          // same-origin files (script-src 'self') and it uses inline styles, which the
          // default style-src allows. Only upgrade-insecure-requests is removed: on plain
          // http://localhost it makes the browser fetch the UI assets over https and the
          // page stays blank. In production HSTS already forces HTTPS for the whole
          // domain (NFR-SEC-06), so the directive adds nothing there.
          upgradeInsecureRequests: null,
        },
      },
    }),
  );

  // Parses the Cookie header into request.cookies; the auth tokens travel in httpOnly
  // cookies (ADR-003).
  app.use(cookieParser());

  // NFR-SEC-03: every body, query and route parameter is validated against its DTO.
  // whitelist + forbidNonWhitelisted reject unknown fields instead of silently dropping
  // them; transform turns the payload into a DTO instance and runs @Transform normalisers.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  setupSwagger(app);
  return app;
}

/**
 * Serves the OpenAPI documentation (NFR-MNT-04): the UI at /api/docs and the JSON at
 * /api/docs-json, in every environment. It is generated from the controllers' and DTOs'
 * decorators, much like springdoc-openapi in Spring Boot.
 *
 * @param app - The application whose routes are documented.
 */
function setupSwagger(app: NestExpressApplication): void {
  const config = new DocumentBuilder()
    .setTitle('R.O.C.K.Y. API')
    .setDescription(
      'REST API of R.O.C.K.Y. Authentication uses httpOnly cookies set by /auth/signup and ' +
        '/auth/login (ADR-003). Errors use the standard error body (design §5.1).',
    )
    .setVersion('1.0')
    .addCookieAuth(
      ID_TOKEN_COOKIE,
      { type: 'apiKey', in: 'cookie', description: 'Firebase ID token, sent to every endpoint.' },
      ID_TOKEN_COOKIE,
    )
    .addCookieAuth(
      REFRESH_TOKEN_COOKIE,
      {
        type: 'apiKey',
        in: 'cookie',
        description: 'Firebase refresh token, sent only to /api/v1/auth/* (refresh, logout).',
      },
      REFRESH_TOKEN_COOKIE,
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(SWAGGER_UI_PATH, app, document, { jsonDocumentUrl: SWAGGER_JSON_PATH });
}
