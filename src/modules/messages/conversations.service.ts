import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  type CursorPage,
  decodeCursor,
  toCursorPageBy,
} from '../../common/pagination/cursor-pagination';
import type { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { assertUserExists } from '../users/user-existence';
import { USER_NOT_FOUND } from '../users/users.constants';
import {
  afterPosition,
  byPair,
  type ConversationRow,
  conversationPosition,
  conversationsQuery,
  type UnreadConversationsCountRow,
  unreadConversationsCountQuery,
} from './conversation-query';
import { ConversationResponseDto } from './dto/conversation-response.dto';
import { UnreadConversationsCountDto } from './dto/unread-conversations-count.dto';
import { CANNOT_MESSAGE_SELF } from './messages.constants';

/** Result of {@link ConversationsService.open}. */
export interface OpenedConversation {
  conversation: ConversationResponseDto;
  /** `true` if this call created the conversation, `false` if it already existed. */
  created: boolean;
}

/**
 * One-to-one conversations (FR-MSG-01, FR-MSG-05, FR-PROF-06).
 *
 * A conversation is stored once per pair of users, with the smaller ID in user_a_id. The
 * unique (user_a_id, user_b_id) constraint and the user_a_id < user_b_id CHECK together
 * guarantee one conversation per pair, whoever starts it.
 */
@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the conversation between the user and the recipient, creating it if needed.
   * Safe under concurrent requests: both callers get the same conversation.
   *
   * @param userId - Internal ID of the signed-in user.
   * @param recipientId - The other user's ID.
   * @returns The conversation and whether this call created it.
   * @throws {BadRequestException} If the recipient is the user.
   * @throws {NotFoundException} If no user has the recipient ID.
   */
  async open(userId: string, recipientId: string): Promise<OpenedConversation> {
    // The validator accepts uppercase UUIDs; IDs from the database are lowercase, and the
    // self check and the pair ordering below compare strings.
    const otherId = recipientId.toLowerCase();
    if (otherId === userId) {
      throw new BadRequestException(CANNOT_MESSAGE_SELF);
    }
    await assertUserExists(this.prisma, otherId);

    const [userAId, userBId] = orderedPair(userId, otherId);
    const now = new Date();
    // INSERT ... ON CONFLICT DO NOTHING on the unique pair: a concurrent request for the
    // same pair waits on the unique index and then inserts nothing, so exactly one caller
    // sees count 1. A recipient deleted after the check fails the foreign key (P2003),
    // which the global exception filter reports as 404.
    const { count } = await this.prisma.conversation.createMany({
      // last_message_at starts at the creation time, so a new, empty conversation sorts
      // as the latest activity in the list.
      data: [{ userAId, userBId, createdAt: now, lastMessageAt: now }],
      skipDuplicates: true,
    });
    const created = count > 0;

    const [row] = await this.query(userId, byPair(userAId, userBId), 1);
    // Only possible if the recipient was deleted in between (the delete cascades).
    if (!row) {
      throw new NotFoundException(USER_NOT_FOUND);
    }
    if (created) {
      this.logger.log(`User ${userId} started conversation ${row.id} with user ${otherId}`);
    }
    return { conversation: ConversationResponseDto.fromRow(row), created };
  }

  /**
   * Returns one page of the user's conversations, latest activity first (FR-MSG-01,
   * ADR-005), each with the other participant, last message and unread count.
   *
   * @param userId - Internal ID of the signed-in user.
   * @param query - Validated cursor and page size.
   * @returns The page and the cursor of the next one.
   * @throws {BadRequestException} If the cursor is invalid.
   */
  async list(
    userId: string,
    query: PaginationQueryDto,
  ): Promise<CursorPage<ConversationResponseDto>> {
    const position = decodeCursor(query.cursor);
    // One extra row tells whether a next page exists (see toCursorPageBy).
    const rows = await this.query(userId, afterPosition(position), query.limit + 1);
    return toCursorPageBy(rows, query.limit, conversationPosition, ConversationResponseDto.fromRow);
  }

  /**
   * Counts the user's conversations that contain at least one unread message from the
   * other participant, for the navigation badge (FR-MSG-06). One query; see
   * {@link unreadConversationsCountQuery} for the indexes it uses.
   *
   * @param userId - Internal ID of the signed-in user.
   * @returns `{ count }`.
   */
  async countUnread(userId: string): Promise<UnreadConversationsCountDto> {
    const rows = await this.prisma.$queryRaw<UnreadConversationsCountRow[]>(
      unreadConversationsCountQuery(userId),
    );
    // An aggregate without GROUP BY always returns one row; 0 is only a type-level fallback.
    return UnreadConversationsCountDto.of(rows[0]?.count ?? 0);
  }

  private query(userId: string, filter: Prisma.Sql, limit: number): Promise<ConversationRow[]> {
    return this.prisma.$queryRaw<ConversationRow[]>(conversationsQuery(userId, filter, limit));
  }
}

/** user_a_id must be the smaller ID (conversations_user_order CHECK). */
function orderedPair(first: string, second: string): [string, string] {
  // Lowercase UUID strings compare in the same order as PostgreSQL's uuid type.
  return first < second ? [first, second] : [second, first];
}
