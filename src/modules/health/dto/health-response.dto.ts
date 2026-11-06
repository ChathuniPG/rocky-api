import { ApiProperty } from '@nestjs/swagger';

/** Body of GET /health (design §5.2): 200 when the database is up, 503 when it is down. */
export class HealthResponseDto {
  @ApiProperty({ enum: ['ok', 'error'], example: 'ok' })
  status: 'ok' | 'error';

  @ApiProperty({ enum: ['up', 'down'], example: 'up' })
  database: 'up' | 'down';

  /**
   * Builds the response for one probe result.
   *
   * @param databaseUp - Whether the database answered.
   * @returns `{ status: 'ok', database: 'up' }` or `{ status: 'error', database: 'down' }`.
   */
  static fromDatabaseStatus(databaseUp: boolean): HealthResponseDto {
    const dto = new HealthResponseDto();
    dto.status = databaseUp ? 'ok' : 'error';
    dto.database = databaseUp ? 'up' : 'down';
    return dto;
  }
}
