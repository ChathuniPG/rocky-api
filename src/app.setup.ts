import { type INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

/** Global route prefix for every endpoint (design.md §5.1). */
export const API_PREFIX = 'api/v1';

/**
 * Applies the app-wide HTTP settings shared by `main.ts` and the e2e tests, so tests
 * exercise exactly the same setup as production.
 *
 * The global auth guard is not registered here: it needs dependency injection, so it is
 * provided with `APP_GUARD` in `AppModule`, which the e2e tests import too.
 *
 * @param app - The Nest application to configure, before it starts listening.
 * @returns The same application, for chaining.
 */
export function configureApp<T extends INestApplication>(app: T): T {
  app.setGlobalPrefix(API_PREFIX);

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
