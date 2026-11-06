import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { trim } from '../../../common/utils/string-transforms';
import {
  MAX_BIO_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from '../users.constants';

/** Skips validation only when the field is absent; `null` is still validated (and rejected). */
const unlessAbsent = (_dto: UpdateProfileDto, value: unknown): boolean => value !== undefined;

/**
 * Body of PATCH /users/me (FR-PROF-04, FR-SET-02, FR-SET-03). Every field is optional,
 * but at least one must be present; UsersService checks that. Fields that are not
 * columns, such as email or username, are rejected by the global ValidationPipe.
 */
export class UpdateProfileDto {
  @ApiPropertyOptional({
    minLength: 1,
    maxLength: MAX_DISPLAY_NAME_LENGTH,
    description: 'Trimmed.',
  })
  @ValidateIf(unlessAbsent)
  @Transform(trim)
  @IsString()
  @Length(1, MAX_DISPLAY_NAME_LENGTH, {
    message: `displayName must be between 1 and ${MAX_DISPLAY_NAME_LENGTH} characters long`,
  })
  displayName?: string;

  // @IsOptional skips both undefined and null: null is a valid value that clears the bio.
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: MAX_BIO_LENGTH,
    description: 'Trimmed. An empty string or null clears the bio.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(MAX_BIO_LENGTH)
  bio?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'The `path` returned by POST /uploads with purpose `avatar`, or null to remove the avatar.',
    example:
      'avatars/6f1c1b1e-8d5a-4a4e-9a51-2b3c4d5e6f70/0b6f6a52-1c1e-4c43-9a2f-1d1b2f3c4d5e.png',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  avatarPath?: string | null;

  @ApiPropertyOptional({ description: 'FR-SET-02: whether new notifications are created.' })
  @ValidateIf(unlessAbsent)
  @IsBoolean()
  notificationsEnabled?: boolean;

  @ApiPropertyOptional({ enum: SUPPORTED_LANGUAGES, description: 'FR-SET-03: interface language.' })
  @ValidateIf(unlessAbsent)
  @IsIn(SUPPORTED_LANGUAGES)
  language?: SupportedLanguage;
}
