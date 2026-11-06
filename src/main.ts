import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { API_PREFIX, configureApp } from './app.setup';
import type { EnvironmentVariables } from './config/env.validation';

const logger = new Logger('Bootstrap');

async function bootstrap(): Promise<void> {
  const app = configureApp(await NestFactory.create<NestExpressApplication>(AppModule));

  // Runs onModuleDestroy / onApplicationShutdown hooks on SIGTERM and SIGINT, so PM2
  // restarts (NFR-OPS-01) can later close database connections cleanly.
  app.enableShutdownHooks();

  // `true` = the config was validated, so get() returns `number` instead of `number | undefined`.
  const config = app.get(ConfigService<EnvironmentVariables, true>);
  const port = config.get('PORT', { infer: true });
  const host = config.get('HOST', { infer: true });

  await app.listen(port, host);
  logger.log(`Listening on http://${formatHostForUrl(host)}:${port}/${API_PREFIX}`);
}

/** IPv6 addresses need square brackets in a URL (http://[::1]:4000); IPv4 does not. */
function formatHostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

bootstrap().catch((error: unknown) => {
  const stack = error instanceof Error ? error.stack : String(error);
  logger.error('Application failed to start', stack);
  // exitCode rather than process.exit(), so pending log output is flushed first.
  process.exitCode = 1;
});
