import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
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
 * double count nor push the counter below zero.
 *
 * If the post is deleted between the existence check and the insert, the foreign key
 * rejects the insert (P2003), which the global exception filter reports as 404.
 */
@Injectable()
export class PostEngagementService {
  constructor(private readonly prisma: PrismaService) {}

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
      if (count === 0) {
        return LikeStateDto.of(true, await this.readLikeCount(tx, postId));
      }
      // TODO(#11): notify the post author about the new like.
      return LikeStateDto.of(true, await this.changeLikeCount(tx, postId, 1));
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
      return LikeStateDto.of(false, await this.changeLikeCount(tx, postId, -1));
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
   */
  private async changeLikeCount(
    tx: Prisma.TransactionClient,
    postId: string,
    delta: 1 | -1,
  ): Promise<number> {
    const { likeCount } = await tx.post.update({
      where: { id: postId },
      data: { likeCount: { increment: delta } },
      select: { likeCount: true },
    });
    return likeCount;
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
