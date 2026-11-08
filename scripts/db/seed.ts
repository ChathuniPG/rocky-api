/**
 * Demo data seed (deferred from #2): six demo users with avatars, ~25 posts, likes, saves,
 * follows, comments and two conversations, created through the application's services.
 *
 *   npm run db:seed                            # create whatever is missing
 *   npm run db:seed -- --reset                 # delete every demo_ user, then seed fresh
 *   npm run db:seed -- --allow-production      # required when NODE_ENV=production
 *
 * Boots AppModule as an application context (no HTTP server), so the real env
 * validation, database connection and Firebase key checks run first. Demo users share
 * the password in SEED_DEMO_PASSWORD. SEED_ENV (local | production) is part of every demo
 * email, because local and production share one Firebase project: each environment only
 * ever sees and deletes its own demo accounts. Running it twice creates nothing the
 * second time.
 *
 * Output: progress, then totals. Never the password, tokens or download URLs (NFR-SEC-04).
 */
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import type { EnvironmentVariables, SeedEnv } from '../../src/config/env.validation';
import { FirebaseDomainError } from '../../src/firebase/firebase.errors';
import { ServiceAccountConfigError } from '../../src/firebase/service-account';
import { DemoSeeder, type DemoDataTotals } from './demo-seeder';
import {
  assertSeedAllowed,
  assertSeedEnvMatches,
  demoEmail,
  parseSeedArgs,
  SeedRefusedError,
} from './seed-plan';

const logger = new Logger('DemoSeed');

async function main(): Promise<void> {
  // Before booting: a typo in a flag must not get as far as a database connection.
  const args = parseSeedArgs(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  try {
    const config = app.get<ConfigService<EnvironmentVariables, true>>(ConfigService);
    const nodeEnv = config.get('NODE_ENV', { infer: true });
    assertSeedAllowed(nodeEnv, args);
    const seedEnv = config.get('SEED_ENV', { infer: true });
    if (seedEnv === undefined) {
      throw new SeedRefusedError(
        'SEED_ENV is not set. Add SEED_ENV=local (or production on the server) to .env.',
      );
    }
    assertSeedEnvMatches(nodeEnv, seedEnv);
    const password = config.get('SEED_DEMO_PASSWORD', { infer: true });
    if (password === undefined) {
      throw new SeedRefusedError(
        'SEED_DEMO_PASSWORD is not set. Add it to .env (see .env.example).',
      );
    }

    const seeder = new DemoSeeder(app, password, seedEnv);
    await seeder.preflight();
    if (args.reset) {
      await seeder.reset();
    }
    const before = await seeder.totals();
    await seeder.seed();
    logSummary(before, await seeder.totals(), seedEnv);
  } finally {
    await app.close();
  }
}

/** One line per table: total demo rows, and how many this run added. */
function logSummary(before: DemoDataTotals, after: DemoDataTotals, seedEnv: SeedEnv): void {
  logger.log('Demo data summary (total, added by this run):');
  const previous = new Map(Object.entries(before));
  for (const [table, total] of Object.entries(after)) {
    const added = total - (previous.get(table) ?? 0);
    logger.log(`  ${table.padEnd(14)} ${String(total).padStart(4)}   +${added}`);
  }
  logger.log(
    `Demo users log in with ${demoEmail('<name>', seedEnv)} (e.g. ${demoEmail('maya', seedEnv)}) ` +
      'and SEED_DEMO_PASSWORD',
  );
}

/**
 * Log-safe description of an error: own and domain messages are fixed strings; for
 * anything else only the class name, because third-party messages may echo secrets.
 */
function describe(error: unknown): string {
  if (
    error instanceof SeedRefusedError ||
    error instanceof FirebaseDomainError ||
    error instanceof ServiceAccountConfigError
  ) {
    return error.message;
  }
  // validateEnv's messages name variables and constraints, never values.
  if (error instanceof Error && error.message.startsWith('Invalid environment configuration')) {
    return error.message;
  }
  if (error instanceof Error && 'getStatus' in error) {
    // NestJS HttpException from a service: messages are the client-facing ones.
    return `${error.name}: ${error.message}`;
  }
  return error instanceof Error ? error.name : 'unknown error';
}

main().catch((error: unknown) => {
  logger.error(`Seed failed: ${describe(error)}`);
  process.exitCode = 1;
});
