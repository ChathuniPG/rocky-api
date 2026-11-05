import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7's CLI no longer reads .env by itself. Node's built-in loader does the same job
// as dotenv without adding a dependency. It never overrides variables that are already set,
// so CI and production values take precedence. The file is optional: CI has no .env.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

/** Prisma CLI configuration (generate, migrate, studio). The Nest app does not read this file. */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Deliberately not `env('DATABASE_URL')`: that helper throws when the variable is
    // missing, which would also break `prisma generate` (e.g. on `npm install` in CI),
    // although generating the client needs no database.
    url: process.env.DATABASE_URL ?? '',
  },
});
