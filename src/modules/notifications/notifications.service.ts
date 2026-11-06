import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { NotificationType } from '../../generated/prisma/enums';

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
 * Creates and removes notifications (FR-NOTF-01, FR-SET-02). Other modules call it from
 * inside their own Prisma transaction and pass the transaction client in, so the
 * notification is written or removed atomically with the like, comment or follow that
 * caused it (ADR-006). Comparable to a Spring service method joining the caller's
 * `@Transactional` boundary, except the transaction is passed in explicitly.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

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
