import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** Route parameter of /posts/:id. A malformed ID is a 400, not a database error. */
export class PostIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  id: string;
}
