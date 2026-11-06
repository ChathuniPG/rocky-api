import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** Route parameter of /conversations/:id/*. A malformed ID is a 400, not a database error. */
export class ConversationIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  id: string;
}
