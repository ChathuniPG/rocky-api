import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Page size when the client sends no `limit` (design §5.1, NFR-PERF-01: 10–20). */
export const DEFAULT_PAGE_SIZE = 15;

/** Largest page a client may request (design §5.1). */
export const MAX_PAGE_SIZE = 50;

/** Cursors this API issues are well under 100 characters; anything longer is not ours. */
const MAX_CURSOR_LENGTH = 200;

/**
 * Query parameters of every cursor-paginated list endpoint (ADR-005). Extend it when an
 * endpoint needs extra filters.
 */
export class PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Opaque `nextCursor` from the previous page. Omit it for the first page.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CURSOR_LENGTH)
  cursor?: string;

  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
    description: 'Number of items per page.',
  })
  // Query values arrive as strings; @Type converts before validation ("abc" becomes NaN
  // and fails @IsInt). The initializer is the default when the parameter is absent.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit: number = DEFAULT_PAGE_SIZE;
}
