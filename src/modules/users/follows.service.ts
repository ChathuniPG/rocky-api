import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { NotificationType } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { FollowStateDto } from './dto/follow-state.dto';
import { CANNOT_FOLLOW_SELF, USER_NOT_FOUND } from './users.constants';

/**
 * Following and unfollowing users (FR-PROF-05). Both operations are idempotent: following
 * twice equals following once, and unfollowing someone you do not follow is a no-op.
 *
 * Uniqueness is enforced by the (follower_id, following_id) primary key, and a CHECK
 * constraint forbids following yourself; the service rejects that earlier with a clear
 * 400. Follower counts are not denormalised: they are counted from the follows table,
 * inside the same transaction as the write, so the returned count includes it. The
 * followed user's FOLLOW notification is created by an insert and removed by a delete in
 * that same transaction (FR-NOTF-01).
 *
 * If the followed user is deleted between the existence check and the insert, the
 * foreign key rejects the insert (P2003), which the global exception filter reports as 404.
 */
@Injectable()
export class FollowsService {
  private readonly logger = new Logger(FollowsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Makes the user follow another user, if not already following.
   *
   * @param followerId - Internal ID of the signed-in user.
   * @param followingId - ID of the user to follow.
   * @returns `isFollowing: true` and the followed user's follower count afterwards.
   * @throws {BadRequestException} If the user tries to follow themselves.
   * @throws {NotFoundException} If no user has this ID.
   */
  async follow(followerId: string, followingId: string): Promise<FollowStateDto> {
    assertNotSelf(followerId, followingId);
    return this.prisma.$transaction(async (tx) => {
      await assertUserExists(tx, followingId);
      // INSERT ... ON CONFLICT DO NOTHING: race-safe against a concurrent identical follow.
      const { count } = await tx.follow.createMany({
        data: [{ followerId, followingId }],
        skipDuplicates: true,
      });
      // A repeated follow inserts nothing and must not notify again.
      if (count > 0) {
        this.logger.log(`User ${followerId} followed user ${followingId}`);
        // ADR-006: notification written in the same transaction as the follow.
        await this.notifications.create(tx, {
          type: NotificationType.FOLLOW,
          actorId: followerId,
          recipientId: followingId,
        });
      }
      return FollowStateDto.of(true, await countFollowers(tx, followingId));
    });
  }

  /**
   * Removes the user's follow of another user, if present.
   *
   * @param followerId - Internal ID of the signed-in user.
   * @param followingId - ID of the user to unfollow.
   * @returns `isFollowing: false` and the user's follower count afterwards.
   * @throws {BadRequestException} If the user tries to unfollow themselves.
   * @throws {NotFoundException} If no user has this ID.
   */
  async unfollow(followerId: string, followingId: string): Promise<FollowStateDto> {
    assertNotSelf(followerId, followingId);
    return this.prisma.$transaction(async (tx) => {
      await assertUserExists(tx, followingId);
      const { count } = await tx.follow.deleteMany({ where: { followerId, followingId } });
      if (count > 0) {
        this.logger.log(`User ${followerId} unfollowed user ${followingId}`);
        // Removed with the follow, so follow → unfollow → follow leaves one notification.
        await this.notifications.removeFollow(tx, followerId, followingId);
      }
      return FollowStateDto.of(false, await countFollowers(tx, followingId));
    });
  }
}

/**
 * Checked before any query. The follows CHECK constraint is only the last line of defence:
 * its violation is not a client-friendly error.
 */
function assertNotSelf(followerId: string, followingId: string): void {
  if (followerId === followingId) {
    throw new BadRequestException(CANNOT_FOLLOW_SELF);
  }
}

async function assertUserExists(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) {
    throw new NotFoundException(USER_NOT_FOUND);
  }
}

/** Served by the follows(following_id) index. */
function countFollowers(tx: Prisma.TransactionClient, userId: string): Promise<number> {
  return tx.follow.count({ where: { followingId: userId } });
}
