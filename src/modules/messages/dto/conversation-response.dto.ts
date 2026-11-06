import { ApiProperty } from '@nestjs/swagger';
import { CursorPageDto } from '../../../common/pagination/cursor-page.dto';
import { PostAuthorDto } from '../../posts/dto/post-response.dto';
import type { ConversationRow } from '../conversation-query';

/** Preview of a conversation's latest message (FR-MSG-01). */
export class ConversationLastMessageDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'See you tomorrow!', maxLength: 1000 })
  body: string;

  @ApiProperty({ format: 'uuid' })
  senderId: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

/**
 * One conversation as seen by the signed-in user (FR-MSG-01, FR-MSG-05). Built field by
 * field, so the internal user_a_id / user_b_id ordering never leaks.
 */
export class ConversationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ type: PostAuthorDto, description: 'The other participant.' })
  otherUser: PostAuthorDto;

  @ApiProperty({
    type: ConversationLastMessageDto,
    nullable: true,
    description: 'The latest message, or null if none has been sent yet.',
  })
  lastMessage: ConversationLastMessageDto | null;

  @ApiProperty({
    example: 2,
    minimum: 0,
    description: 'Messages from the other participant that you have not read.',
  })
  unreadCount: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Time of the latest message, or of creation if there is none. Sort key.',
  })
  lastMessageAt: Date;

  /**
   * Maps a flat row from `conversationsQuery` to the response shape.
   *
   * @param row - The conversation row.
   * @returns The response DTO.
   */
  static fromRow(this: void, row: ConversationRow): ConversationResponseDto {
    const otherUser = new PostAuthorDto();
    otherUser.id = row.otherUserId;
    otherUser.username = row.otherUsername;
    otherUser.displayName = row.otherDisplayName;
    otherUser.avatarUrl = row.otherAvatarUrl;

    const dto = new ConversationResponseDto();
    dto.id = row.id;
    dto.otherUser = otherUser;
    dto.lastMessage = toLastMessageDto(row);
    dto.unreadCount = row.unreadCount;
    dto.lastMessageAt = row.lastMessageAt;
    return dto;
  }
}

/** One page of conversations, latest activity first (ADR-005). */
export class ConversationPageDto extends CursorPageDto(ConversationResponseDto) {}

/** The LEFT JOIN yields all-null message columns for a conversation without messages. */
function toLastMessageDto(row: ConversationRow): ConversationLastMessageDto | null {
  if (
    row.lastMessageId === null ||
    row.lastMessageBody === null ||
    row.lastMessageSenderId === null ||
    row.lastMessageCreatedAt === null
  ) {
    return null;
  }
  const dto = new ConversationLastMessageDto();
  dto.id = row.lastMessageId;
  dto.body = row.lastMessageBody;
  dto.senderId = row.lastMessageSenderId;
  dto.createdAt = row.lastMessageCreatedAt;
  return dto;
}
