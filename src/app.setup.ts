import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { createRequestLoggingMiddleware } from './common/middleware/request-logging.middleware';

/** Global route prefix for every endpoint (design.md §5.1). */
export const API_PREFIX = 'api/v1';

/** Full path of the health check, used to keep successful probes out of the request log. */
export const HEALTH_CHECK_PATH = `/${API_PREFIX}/health`;

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

  // Standard security headers (nosniff, frame-ancestors, HSTS, CSP, ...).
  app.use(helmet());

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
  return app;
}
