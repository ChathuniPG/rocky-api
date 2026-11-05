import type { INestApplication } from '@nestjs/common';

/** Global route prefix for every endpoint (design.md §5.1). */
export const API_PREFIX = 'api/v1';

/**
 * Applies the app-wide HTTP settings shared by `main.ts` and the e2e tests, so tests
 * exercise exactly the same setup as production.
 *
 * @param app - The Nest application to configure, before it starts listening.
 * @returns The same application, for chaining.
 */
export function configureApp<T extends INestApplication>(app: T): T {
  app.setGlobalPrefix(API_PREFIX);
  return app;
}
