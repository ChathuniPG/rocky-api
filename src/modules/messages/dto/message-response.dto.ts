import { ApiProperty } from '@nestjs/swagger';
import { CursorPageDto } from '../../../common/pagination/cursor-page.dto';
import type { MessageRow } from '../message-query';
import { MAX_MESSAGE_LENGTH } from '../messages.constants';

/** One message of a conversation (FR-MSG-02, FR-MSG-03). */
export class MessageResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  conversationId: string;

  @ApiProperty({ format: 'uuid', description: 'Compare with your own ID to align the bubble.' })
  senderId: string;

  @ApiProperty({ example: 'See you tomorrow!', maxLength: MAX_MESSAGE_LENGTH })
  body: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the recipient read it; null while unread.',
  })
  readAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  /**
   * Maps a row selected with `messageSelect` to the response shape.
   *
   * @param row - The message row.
   * @returns The response DTO.
   */
  static fromRow(this: void, row: MessageRow): MessageResponseDto {
    const dto = new MessageResponseDto();
    dto.id = row.id;
    dto.conversationId = row.conversationId;
    dto.senderId = row.senderId;
    dto.body = row.body;
    dto.readAt = row.readAt;
    dto.createdAt = row.createdAt;
    return dto;
  }
}

/** One page of messages (ADR-005). */
export class MessagePageDto extends CursorPageDto(MessageResponseDto) {}
