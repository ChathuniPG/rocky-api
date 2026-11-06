import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsString, Length } from 'class-validator';
import { PaginationQueryDto } from '../../../common/pagination/pagination-query.dto';
import { trim } from '../../../common/utils/string-transforms';
import { MAX_SEARCH_QUERY_LENGTH, SEARCH_FILTERS, type SearchFilter } from '../users.constants';

/** Query parameters of GET /users/search (FR-SRCH-01, FR-SRCH-03), plus cursor and limit. */
export class SearchUsersQueryDto extends PaginationQueryDto {
  @ApiProperty({
    minLength: 1,
    maxLength: MAX_SEARCH_QUERY_LENGTH,
    example: 'ali',
    description:
      'Trimmed. Case-insensitive partial match on username or display name; % and _ match ' +
      'themselves, not any character.',
  })
  @Transform(trim)
  @IsString()
  @Length(1, MAX_SEARCH_QUERY_LENGTH, {
    message: `q must be between 1 and ${MAX_SEARCH_QUERY_LENGTH} characters long`,
  })
  q: string;

  @ApiPropertyOptional({
    enum: SEARCH_FILTERS,
    default: 'all',
    description: '`following` limits the results to users you follow.',
  })
  @IsIn(SEARCH_FILTERS)
  filter: SearchFilter = 'all';
}
