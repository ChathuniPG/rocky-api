import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { HealthResponseDto } from './dto/health-response.dto';
import { HealthService } from './health.service';

/**
 * Health check (NFR-OPS-03), comparable to Spring Boot Actuator's /actuator/health.
 * Public (NFR-SEC-01) so Nginx, PM2 tooling or an uptime monitor can call it without a
 * session.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * Reports API and database status. A down database returns 503 with the health body
   * rather than throwing: monitors expect this exact shape, not the standard error body.
   */
  @Public()
  @Get()
  async check(@Res({ passthrough: true }) response: Response): Promise<HealthResponseDto> {
    const databaseUp = await this.healthService.isDatabaseUp();
    response.status(databaseUp ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return HealthResponseDto.fromDatabaseStatus(databaseUp);
  }
}
