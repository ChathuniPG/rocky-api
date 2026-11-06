import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';
import { trimAndLowercase } from '../../../common/utils/string-transforms';
import { USERNAME_PATTERN } from '../users.constants';

/**
 * Route parameter of /users/:username. Lowercased, because usernames are stored in
 * lowercase, so /users/Alice finds alice. A value no username can have is a 400.
 */
export class UsernameParamDto {
  @ApiProperty({ example: 'alice', pattern: USERNAME_PATTERN.source })
  @Transform(trimAndLowercase)
  @IsString()
  @Matches(USERNAME_PATTERN, { message: 'username is not a valid username' })
  username: string;
}
