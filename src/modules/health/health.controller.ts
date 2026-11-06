import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { HealthResponseDto } from './dto/health-response.dto';
import { HealthService } from './health.service';

/**
 * Health check (NFR-OPS-03), comparable to Spring Boot Actuator's /actuator/health.
 * Public (NFR-SEC-01) so Nginx, PM2 tooling or an uptime monitor can call it without a
 * session. Not rate limited: a monitor polling from one IP must never be locked out, and
 * the probe is a single cheap query.
 */
@ApiTags('System')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * Reports API and database status. A down database returns 503 with the health body
   * rather than throwing: monitors expect this exact shape, not the standard error body.
   */
  @Public()
  @Get()
  @ApiOperation({ summary: 'API and database status' })
  @ApiOkResponse({
    type: HealthResponseDto,
    description: 'The database answered.',
    example: { status: 'ok', database: 'up' },
  })
  @ApiServiceUnavailableResponse({
    type: HealthResponseDto,
    description: 'The database did not answer within 3 seconds.',
    example: { status: 'error', database: 'down' },
  })
  async check(@Res({ passthrough: true }) response: Response): Promise<HealthResponseDto> {
    const databaseUp = await this.healthService.isDatabaseUp();
    response.status(databaseUp ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return HealthResponseDto.fromDatabaseStatus(databaseUp);
  }
}
