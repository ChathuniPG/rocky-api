import { ApiProperty } from '@nestjs/swagger';
import type { ErrorResponseBody } from '../filters/all-exceptions.filter';

/**
 * OpenAPI schema of the standard error body written by `AllExceptionsFilter`
 * (design §5.1). Implements `ErrorResponseBody`, so the documentation cannot drift from
 * what the filter actually sends without a compile error.
 */
export class ErrorResponseDto implements ErrorResponseBody {
  @ApiProperty({ example: 400 })
  statusCode: number;

  @ApiProperty({ example: 'Bad Request', description: 'Standard reason phrase of the status.' })
  error: string;

  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    example: ['email must be a valid email address'],
    description: 'Safe client message. Validation errors return one message per failed rule.',
  })
  message: string | string[];

  @ApiProperty({ example: '/api/v1/auth/signup', description: 'Request path without query.' })
  path: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-06T10:15:30.000Z' })
  timestamp: string;
}
