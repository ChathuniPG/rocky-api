import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import type { EnvironmentVariables } from '../config/env.validation';
import { PrismaClient } from '../generated/prisma/client';

/**
 * How long the pool waits for a new connection before failing. node-postgres defaults to
 * 0 (wait forever), and Prisma 7 no longer applies its own 5 s default. Without a timeout,
 * an unreachable host that drops packets (rather than refusing the connection) would hang
 * startup instead of failing it.
 */
export const DATABASE_CONNECTION_TIMEOUT_MS = 5000;

/**
 * The application's single database client (ADR-001). Inject it into services, never
 * into controllers: only services access the database.
 *
 * Extends the generated `PrismaClient`, so every model is available directly, e.g.
 * `this.prisma.post.findMany()`. Opens the connection pool at startup and closes it on
 * shutdown (triggered by `enableShutdownHooks()` in main.ts).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    // Prisma 7 talks to PostgreSQL through a driver adapter (node-postgres pool).
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_URL', { infer: true }),
        connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MS,
      }),
    });
  }

  /**
   * Connects to the database when the module initialises, so the app fails at startup
   * rather than on the first request if the database is unreachable.
   *
   * @throws {Error} The Prisma error if the database cannot be reached. It names the
   *   host and port only, never the credentials.
   */
  async onModuleInit(): Promise<void> {
    await this.$connect();
    // With a driver adapter, $connect() resolves without opening a connection (verified
    // against an unreachable port). A trivial query forces one, so startup really fails fast.
    await this.$queryRaw`SELECT 1`;
    // Never log DATABASE_URL: it contains the password (NFR-SEC-04).
    this.logger.log('Connected to the database');
  }

  /** Closes the connection pool on application shutdown (SIGTERM/SIGINT, `app.close()`). */
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Disconnected from the database');
  }
}
