import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { trimAndLowercase } from '../../../common/utils/string-transforms';
import { PASSWORD_MAX_LENGTH } from './signup.dto';

/** Request body of POST /auth/login (FR-AUTH-03). */
export class LoginDto {
  // Normalised the same way as at sign-up, so the stored email matches.
  @ApiProperty({ format: 'email', maxLength: 255, example: 'alice@example.com' })
  @Transform(trimAndLowercase)
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(255)
  email: string;

  // No strength rules at login: Firebase decides whether the password is right, and
  // rules here would only reveal the password policy.
  @ApiProperty({ format: 'password', maxLength: PASSWORD_MAX_LENGTH, example: 'secret123' })
  @IsString()
  @IsNotEmpty({ message: 'password must not be empty' })
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;
}
