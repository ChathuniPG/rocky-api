import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, ValidateIf } from 'class-validator';
import { trim } from '../../../common/utils/string-transforms';
import { MAX_CAPTION_LENGTH } from '../posts.constants';

/** Body of POST /posts (FR-POST-01, ADR-007). */
export class CreatePostDto {
  @ApiPropertyOptional({ maxLength: MAX_CAPTION_LENGTH, default: '', example: 'Sunset' })
  // Not @IsOptional: that also skips validation for null, which would reach the NOT NULL
  // column. Only an absent caption falls back to ''.
  @ValidateIf((_dto: CreatePostDto, value: unknown) => value !== undefined)
  @Transform(trim)
  @IsString()
  // Counts UTF-16 code units, so an emoji counts as 2. varchar(2200) counts characters,
  // so this check is never looser than the database.
  @MaxLength(MAX_CAPTION_LENGTH)
  caption: string = '';

  @ApiProperty({
    description: 'The `path` returned by POST /uploads with purpose `post`.',
    example: 'posts/6f1c1b1e-8d5a-4a4e-9a51-2b3c4d5e6f70/0b6f6a52-1c1e-4c43-9a2f-1d1b2f3c4d5e.png',
  })
  @IsString()
  @MaxLength(255)
  mediaPath: string;
}
