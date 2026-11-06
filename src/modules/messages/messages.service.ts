import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  type CursorPage,
  decodeCursor,
  keysetAscendingOrderBy,
  keysetNewerWhere,
  keysetOrderBy,
  keysetWhere,
  toCursorPage,
} from '../../common/pagination/cursor-pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { assertParticipant } from './conversation-access';
import type { CreateMessageDto } from './dto/create-message.dto';
import type { ListMessagesQueryDto } from './dto/list-messages-query.dto';
import { MessageResponseDto } from './dto/message-response.dto';
import { messageSelect } from './message-query';
import { CURSOR_WITH_AFTER, INVALID_AFTER } from './messages.constants';

/**
 * Messages of one-to-one conversations (FR-MSG-02 to FR-MSG-05). New messages reach the
 * other participant by polling (ADR-008). Every operation first checks that the
 * signed-in user is a participant (NFR-SEC-02).
 */
@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns a conversation's messages, in one of two modes:
   * - history (no `after`): one page, newest first, paginated with `cursor` (ADR-005);
   *   the client reverses it to show messages in chronological order (FR-MSG-02);
   * - polling (`after`): up to `limit` messages strictly newer than `after`, oldest
   *   first, with `nextCursor` null (FR-MSG-04, ADR-008).
   *
   * @param userId - Internal ID of the signed-in user; must be a participant.
   * @param conversationId - The conversation's ID.
   * @param query - Validated cursor, page size and optional `after` message ID.
   * @returns The page of messages.
   * @throws {BadRequestException} If the cursor is invalid, both `cursor` and `after` are
   *   given, or `after` is not a message of this conversation.
   * @throws {NotFoundException} If the user has no conversation with this ID.
   */
  async list(
    userId: string,
    conversationId: string,
    query: ListMessagesQueryDto,
  ): Promise<CursorPage<MessageResponseDto>> {
    if (query.after !== undefined && query.cursor !== undefined) {
      throw new BadRequestException(CURSOR_WITH_AFTER);
    }
    const position = decodeCursor(query.cursor);
    await assertParticipant(this.prisma, conversationId, userId);
    if (query.after !== undefined) {
      return this.listNewer(conversationId, query.after, query.limit);
    }

    const rows = await this.prisma.message.findMany({
      // Served by the (conversation_id, created_at, id) index.
      where: { conversationId, ...keysetWhere(position) },
      orderBy: keysetOrderBy(),
      // One extra row tells whether a next page exists (see toCursorPage).
      take: query.limit + 1,
      select: messageSelect,
    });
    return toCursorPage(rows, query.limit, MessageResponseDto.fromRow);
  }

  /**
   * Sends a message and moves the conversation's last_message_at to it, in one
   * transaction (ADR-006), so the conversation list never shows a stale order.
   *
   * @param senderId - Internal ID of the signed-in user; must be a participant.
   * @param conversationId - The conversation's ID.
   * @param dto - The validated, trimmed body.
   * @returns The new message.
   * @throws {NotFoundException} If the user has no conversation with this ID.
   */
  async send(
    senderId: string,
    conversationId: string,
    dto: CreateMessageDto,
  ): Promise<MessageResponseDto> {
    const row = await this.prisma.$transaction(async (tx) => {
      await assertParticipant(tx, conversationId, senderId);
      const message = await tx.message.create({
        data: { conversationId, senderId, body: dto.body },
        select: messageSelect,
      });
      // The `lt` guard keeps last_message_at monotonic: if two sends race and the later
      // message's transaction commits first, the earlier one must not move it backwards.
      await tx.conversation.updateMany({
        where: { id: conversationId, lastMessageAt: { lt: message.createdAt } },
        data: { lastMessageAt: message.createdAt },
      });
      return message;
    });
    // The body is private content and is never logged.
    this.logger.log(`User ${senderId} sent message ${row.id} in conversation ${conversationId}`);
    return MessageResponseDto.fromRow(row);
  }

  /**
   * Marks the other participant's unread messages in the conversation as read
   * (FR-MSG-05). Idempotent. The user's own messages are never changed: they are read
   * when the other participant reads them.
   *
   * @param userId - Internal ID of the signed-in user; must be a participant.
   * @param conversationId - The conversation's ID.
   * @throws {NotFoundException} If the user has no conversation with this ID.
   */
  async markRead(userId: string, conversationId: string): Promise<void> {
    await assertParticipant(this.prisma, conversationId, userId);
    await this.prisma.message.updateMany({
      where: { conversationId, senderId: { not: userId }, readAt: null },
      data: { readAt: new Date() },
    });
  }

  /** Polling mode of {@link list}. */
  private async listNewer(
    conversationId: string,
    afterId: string,
    limit: number,
  ): Promise<CursorPage<MessageResponseDto>> {
    // Scoped to the conversation, so `after` cannot be used to probe other conversations.
    const after = await this.prisma.message.findFirst({
      where: { id: afterId, conversationId },
      select: { id: true, createdAt: true },
    });
    if (!after) {
      throw new BadRequestException(INVALID_AFTER);
    }
    const rows = await this.prisma.message.findMany({
      where: { conversationId, ...keysetNewerWhere(after) },
      orderBy: keysetAscendingOrderBy(),
      take: limit,
      select: messageSelect,
    });
    // No cursor: the client polls again with the newest ID it has, which also picks up
    // any messages beyond this batch.
    return { items: rows.map((row) => MessageResponseDto.fromRow(row)), nextCursor: null };
  }
}
