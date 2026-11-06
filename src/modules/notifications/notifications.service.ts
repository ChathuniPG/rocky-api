import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  type CursorPage,
  decodeCursor,
  keysetOrderBy,
  keysetWhere,
  toCursorPage,
} from '../../common/pagination/cursor-pagination';
import type { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import type { Prisma } from '../../generated/prisma/client';
import { NotificationType } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationResponseDto } from './dto/notification-response.dto';
import { UnreadCountDto } from './dto/unread-count.dto';
import { notificationSelect } from './notification-query';
import { NOTIFICATION_NOT_FOUND } from './notifications.constants';

/** A like on the recipient's post. */
export interface NewLikeNotification {
  type: typeof NotificationType.LIKE;
  actorId: string;
  recipientId: string;
  postId: string;
}

/** A comment on the recipient's post. */
export interface NewCommentNotification {
  type: typeof NotificationType.COMMENT;
  actorId: string;
  recipientId: string;
  postId: string;
  commentId: string;
}

/** The actor started following the recipient. */
export interface NewFollowNotification {
  type: typeof NotificationType.FOLLOW;
  actorId: string;
  recipientId: string;
}

/**
 * Input of {@link NotificationsService.create}. A discriminated union, so the compiler
 * rejects a LIKE without a post, a COMMENT without a comment or a FOLLOW with a post.
 */
export type NewNotification = NewLikeNotification | NewCommentNotification | NewFollowNotification;

/**
 * Notifications (FR-NOTF-01 to FR-NOTF-04, FR-SET-02).
 *
 * Creating and removing: other modules call {@link create}, {@link removeLike} and
 * {@link removeFollow} from inside their own Prisma transaction and pass the transaction
 * client in, so the notification is written or removed atomically with the like, comment
 * or follow that caused it (ADR-006). Comparable to a Spring service method joining the
 * caller's `@Transactional` boundary, except the transaction is passed in explicitly.
 *
 * Reading and marking as read: always scoped to the signed-in recipient (NFR-SEC-02).
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns one page of the user's notifications, newest first (FR-NOTF-02, ADR-005).
   *
   * @param userId - Internal ID of the signed-in user.
   * @param query - Validated cursor and page size.
   * @returns The page and the cursor of the next one.
   * @throws {BadRequestException} If the cursor is invalid.
   */
  async list(
    userId: string,
    query: PaginationQueryDto,
  ): Promise<CursorPage<NotificationResponseDto>> {
    const position = decodeCursor(query.cursor);
    const rows = await this.prisma.notification.findMany({
      // Served by the (recipient_id, created_at, id) index.
      where: { recipientId: userId, ...keysetWhere(position) },
      orderBy: keysetOrderBy(),
      // One extra row tells whether a next page exists (see toCursorPage).
      take: query.limit + 1,
      select: notificationSelect,
    });
    return toCursorPage(rows, query.limit, NotificationResponseDto.fromRow);
  }

  /**
   * Counts the user's unread notifications, for the navigation badge (FR-NOTF-04).
   *
   * @param userId - Internal ID of the signed-in user.
   * @returns `{ count }`.
   */
  async countUnread(userId: string): Promise<UnreadCountDto> {
    // Served by the (recipient_id, is_read) index.
    const count = await this.prisma.notification.count({
      where: { recipientId: userId, isRead: false },
    });
    return UnreadCountDto.of(count);
  }

  /**
   * Marks one of the user's notifications as read (FR-NOTF-03). Idempotent: marking a
   * notification that is already read succeeds.
   *
   * @param userId - Internal ID of the signed-in user; must be the recipient.
   * @param notificationId - The notification's ID.
   * @throws {NotFoundException} If the user has no notification with this ID, including
   *   when it belongs to someone else.
   */
  async markRead(userId: string, notificationId: string): Promise<void> {
    // NFR-SEC-02: the recipient is part of the WHERE, so the ownership check and the
    // update are one statement, and another user's notification looks exactly like a
    // missing one (404, not 403), which does not reveal that it exists.
    const { count } = await this.prisma.notification.updateMany({
      where: { id: notificationId, recipientId: userId },
      data: { isRead: true },
    });
    if (count === 0) {
      throw new NotFoundException(NOTIFICATION_NOT_FOUND);
    }
  }

  /**
   * Marks all of the user's notifications as read (FR-NOTF-03).
   *
   * @param userId - Internal ID of the signed-in user.
   */
  async markAllRead(userId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { recipientId: userId, isRead: false },
      data: { isRead: true },
    });
  }

  /**
   * Notifies the recipient of the actor's action, unless the actor is the recipient
   * (FR-NOTF-01) or the recipient turned notifications off (FR-SET-02).
   *
   * @param tx - The caller's transaction client.
   * @param input - What happened, who did it and who is notified.
   * @returns Resolves once the notification is written, or skipped.
   */
  async create(tx: Prisma.TransactionClient, input: NewNotification): Promise<void> {
    if (input.actorId === input.recipientId) {
      return;
    }
    const recipient = await tx.user.findUnique({
      where: { id: input.recipientId },
      select: { notificationsEnabled: true },
    });
    // A missing recipient can only mean a concurrent account deletion: nothing to notify.
    if (!recipient?.notificationsEnabled) {
      return;
    }
    const { id } = await tx.notification.create({ data: { ...input }, select: { id: true } });
    this.logger.log(`Notification ${id} (${input.type}) created for user ${input.recipientId}`);
  }

  /**
   * Removes the actor's LIKE notification for a post, after an unlike, so toggling a like
   * never leaves duplicates behind.
   *
   * @param tx - The caller's transaction client.
   * @param actorId - The user who removed their like.
   * @param postId - The post that was unliked.
   * @returns Resolves once any matching notification is deleted.
   */
  async removeLike(tx: Prisma.TransactionClient, actorId: string, postId: string): Promise<void> {
    await tx.notification.deleteMany({
      where: { type: NotificationType.LIKE, actorId, postId },
    });
  }

  /**
   * Removes the actor's FOLLOW notification for a user, after an unfollow, so toggling a
   * follow never leaves duplicates behind.
   *
   * @param tx - The caller's transaction client.
   * @param actorId - The user who unfollowed.
   * @param recipientId - The user who was unfollowed.
   * @returns Resolves once any matching notification is deleted.
   */
  async removeFollow(
    tx: Prisma.TransactionClient,
    actorId: string,
    recipientId: string,
  ): Promise<void> {
    await tx.notification.deleteMany({
      where: { type: NotificationType.FOLLOW, actorId, recipientId },
    });
  }
}
