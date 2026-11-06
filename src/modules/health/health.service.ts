import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Upper bound for the database probe. It is shorter than the pool's connection timeout
 * (5 s, see PrismaService), so a hanging database gets a fast 503 instead of making the
 * load balancer or monitor time out first.
 */
export const HEALTH_CHECK_TIMEOUT_MS = 3000;

/** Database health probe used by GET /health (NFR-OPS-03). */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Checks that PostgreSQL answers a trivial query within {@link HEALTH_CHECK_TIMEOUT_MS}.
   *
   * @returns `true` if `SELECT 1` succeeds in time, otherwise `false`. Never throws.
   */
  async isDatabaseUp(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('Database health check timed out'));
      }, HEALTH_CHECK_TIMEOUT_MS);
    });

    try {
      await Promise.race([this.prisma.$queryRaw`SELECT 1`, timeout]);
      return true;
    } catch (error: unknown) {
      // The error name only: Prisma messages can include the host and other details.
      const name = error instanceof Error ? error.name : 'unknown error';
      this.logger.warn(`Database health check failed: ${name}`);
      return false;
    } finally {
      // Clears the timer so it does not keep the event loop (or a test) alive.
      clearTimeout(timer);
    }
  }
}
