import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { NotificationType } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LikeStateDto } from './dto/like-state.dto';
import { SaveStateDto } from './dto/save-state.dto';
import { assertPostExists } from './post-existence';
import { POST_NOT_FOUND } from './posts.constants';

/**
 * Likes and saves of posts (FR-FEED-03, FR-FEED-04). Every operation is idempotent:
 * liking twice equals liking once, and unliking a post that is not liked is a no-op.
 *
 * Uniqueness is enforced by the (user_id, post_id) primary keys (NFR-DATA-01), and the
 * insert / delete reports whether a row actually changed. like_count only moves when one
 * did, in the same transaction (ADR-006), so repeated or concurrent calls can neither
 * double count nor push the counter below zero. The author's LIKE notification follows
 * the same rule: created only by an insert, removed only by a delete (FR-NOTF-01).
 *
 * If the post is deleted between the existence check and the insert, the foreign key
 * rejects the insert (P2003), which the global exception filter reports as 404.
 */
@Injectable()
export class PostEngagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Likes a post for the user, if not already liked.
   *
   * @param userId - Internal ID of the signed-in user.
   * @param postId - The post's ID.
   * @returns `likedByMe: true` and the post's like count afterwards.
   * @throws {NotFoundException} If no post has this ID.
   */
  async like(userId: string, postId: string): Promise<LikeStateDto> {
    return this.prisma.$transaction(async (tx) => {
      await assertPostExists(tx, postId);
      // INSERT ... ON CONFLICT DO NOTHING: race-safe against a concurrent identical like,
      // and the count says whether this call created the row.
      const { count } = await tx.like.createMany({
        data: [{ userId, postId }],
        skipDuplicates: true,
      });
      // A repeated like inserts nothing and must not notify again.
      if (count === 0) {
        return LikeStateDto.of(true, await this.readLikeCount(tx, postId));
      }
      const { likeCount, authorId } = await this.changeLikeCount(tx, postId, 1);
      // ADR-006: notification written in the same transaction as the like.
      await this.notifications.create(tx, {
        type: NotificationType.LIKE,
        actorId: userId,
        recipientId: authorId,
        postId,
      });
      return LikeStateDto.of(true, likeCount);
    });
  }

  /**
   * Removes the user's like from a post, if present.
   *
   * @param userId - Internal ID of the signed-in user.
   * @param postId - The post's ID.
   * @returns `likedByMe: false` and the post's like count afterwards.
   * @throws {NotFoundException} If no post has this ID.
   */
  async unlike(userId: string, postId: string): Promise<LikeStateDto> {
    return this.prisma.$transaction(async (tx) => {
      await assertPostExists(tx, postId);
      // A concurrent second unlike blocks on the row lock, then deletes nothing, so only
      // one of them decrements.
      const { count } = await tx.like.deleteMany({ where: { userId, postId } });
      if (count === 0) {
        return LikeStateDto.of(false, await this.readLikeCount(tx, postId));
      }
      // Removed with the like, so like → unlike → like leaves exactly one notification.
      await this.notifications.removeLike(tx, userId, postId);
      const { likeCount } = await this.changeLikeCount(tx, postId, -1);
      return LikeStateDto.of(false, likeCount);
    });
  }

  /**
   * Saves a post for the user, if not already saved. Saves have no counter.
   *
   * @param userId - Internal ID of the signed-in user.
   * @param postId - The post's ID.
   * @returns `savedByMe: true`.
   * @throws {NotFoundException} If no post has this ID.
   */
  async save(userId: string, postId: string): Promise<SaveStateDto> {
    await assertPostExists(this.prisma, postId);
    await this.prisma.save.createMany({ data: [{ userId, postId }], skipDuplicates: true });
    return SaveStateDto.of(true);
  }

  /**
   * Removes the user's save of a post, if present.
   *
   * @param userId - Internal ID of the signed-in user.
   * @param postId - The post's ID.
   * @returns `savedByMe: false`.
   * @throws {NotFoundException} If no post has this ID.
   */
  async unsave(userId: string, postId: string): Promise<SaveStateDto> {
    await assertPostExists(this.prisma, postId);
    await this.prisma.save.deleteMany({ where: { userId, postId } });
    return SaveStateDto.of(false);
  }

  /**
   * ADR-006: an atomic `like_count = like_count + delta` in SQL, never a read-modify-write
   * in JavaScript, so concurrent likes by different users cannot overwrite each other.
   * Also returns the author, the like notification's recipient, without an extra query.
   */
  private changeLikeCount(
    tx: Prisma.TransactionClient,
    postId: string,
    delta: 1 | -1,
  ): Promise<{ likeCount: number; authorId: string }> {
    return tx.post.update({
      where: { id: postId },
      data: { likeCount: { increment: delta } },
      select: { likeCount: true, authorId: true },
    });
  }

  private async readLikeCount(tx: Prisma.TransactionClient, postId: string): Promise<number> {
    const post = await tx.post.findUnique({ where: { id: postId }, select: { likeCount: true } });
    // Only possible if the post was deleted concurrently, after the existence check.
    if (!post) {
      throw new NotFoundException(POST_NOT_FOUND);
    }
    return post.likeCount;
  }
}
