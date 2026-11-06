import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../../common/pagination/pagination-query.dto';

/**
 * Query of GET /conversations/:id/messages. Without `after`: history, newest first,
 * paginated with `cursor` (ADR-005). With `after`: polling for new messages (ADR-008).
 */
export class ListMessagesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Polling: the ID of the newest message you have. Returns up to `limit` messages ' +
      'strictly newer than it, oldest first, with `nextCursor` null; poll again with the ' +
      'last returned ID. Cannot be combined with `cursor`.',
  })
  @IsOptional()
  @IsUUID('all')
  after?: string;
}
