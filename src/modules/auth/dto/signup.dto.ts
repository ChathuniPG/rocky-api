import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';
import { trim, trimAndLowercase } from '../../../common/utils/string-transforms';

/** Upper bound for passwords: blocks oversized payloads; far above any real password. */
export const PASSWORD_MAX_LENGTH = 128;

/** Request body of POST /auth/signup (FR-AUTH-01, FR-AUTH-02). */
export class SignupDto {
  // Normalised so "Alice@Example.com " and "alice@example.com" are the same account.
  // 255 = users.email column length.
  @Transform(trimAndLowercase)
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(255)
  email: string;

  // FR-AUTH-02: at least 8 characters with at least one letter and one number. Not
  // trimmed: spaces are legitimate password characters.
  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters long' })
  @MaxLength(PASSWORD_MAX_LENGTH)
  @Matches(/^(?=.*\p{L})(?=.*\d)/u, {
    message: 'password must contain at least one letter and one number',
  })
  password: string;

  // FR-AUTH-02; the same pattern is enforced by the users_username_format CHECK
  // constraint in the database.
  @Transform(trimAndLowercase)
  @IsString()
  @Length(3, 30, { message: 'username must be between 3 and 30 characters long' })
  @Matches(/^[a-z0-9_.]+$/, {
    message: 'username may only contain lowercase letters, numbers, underscores and periods',
  })
  username: string;

  @Transform(trim)
  @IsString()
  @Length(1, 50, { message: 'displayName must be between 1 and 50 characters long' })
  displayName: string;
}
