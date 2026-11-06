import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** Route parameter of /users/:id/follow. A malformed ID is a 400, not a database error. */
export class UserIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  id: string;
}
