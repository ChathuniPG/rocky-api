import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength } from 'class-validator';
import { trim } from '../../../common/utils/string-transforms';
import { MAX_CAPTION_LENGTH } from '../posts.constants';

/**
 * Body of PATCH /posts/:id (FR-POST-04). Only the caption is editable; media cannot be
 * swapped after posting, and any other field is rejected by the global ValidationPipe.
 */
export class UpdatePostDto {
  @ApiProperty({
    maxLength: MAX_CAPTION_LENGTH,
    description: 'The new caption; an empty string removes it.',
    example: 'Sunset at the beach',
  })
  @Transform(trim)
  @IsString()
  @MaxLength(MAX_CAPTION_LENGTH)
  caption: string;
}
