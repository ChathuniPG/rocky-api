import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { trim } from '../../../common/utils/string-transforms';
import { MAX_MESSAGE_LENGTH } from '../messages.constants';

/** Body of POST /conversations/:id/messages (FR-MSG-03). */
export class CreateMessageDto {
  @ApiProperty({
    minLength: 1,
    maxLength: MAX_MESSAGE_LENGTH,
    description: 'Trimmed; must not be blank.',
    example: 'See you tomorrow!',
  })
  // Trimmed before validation, so IsNotEmpty also rejects whitespace-only bodies. The
  // messages_body_not_blank CHECK constraint enforces the same rule in the database.
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_MESSAGE_LENGTH)
  body: string;
}
