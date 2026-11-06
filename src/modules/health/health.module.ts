import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/** GET /health (design §6). PrismaService comes from the global PrismaModule. */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
