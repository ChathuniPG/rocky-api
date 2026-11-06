import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { trim } from '../../../common/utils/string-transforms';
import { MAX_COMMENT_LENGTH } from '../posts.constants';

/** Body of POST /posts/:id/comments (FR-FEED-06). */
export class CreateCommentDto {
  @ApiProperty({
    minLength: 1,
    maxLength: MAX_COMMENT_LENGTH,
    description: 'Trimmed; must not be blank.',
    example: 'Great shot!',
  })
  // Trimmed before validation, so IsNotEmpty also rejects whitespace-only bodies. The
  // comments_body_not_blank CHECK constraint enforces the same rule in the database.
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_COMMENT_LENGTH)
  body: string;
}
