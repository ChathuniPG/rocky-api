import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** Route parameter of /comments/:id. A malformed ID is a 400, not a database error. */
export class CommentIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  id: string;
}
