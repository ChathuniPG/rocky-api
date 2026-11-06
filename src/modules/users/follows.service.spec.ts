import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { FollowsService } from './follows.service';
import { CANNOT_FOLLOW_SELF, USER_NOT_FOUND } from './users.constants';

const USER_ID = '6f1c1b1e-8d5a-4a4e-9a51-2b3c4d5e6f70';
const OTHER_USER_ID = '7a2d2c2f-9e6b-4b5f-8a62-3c4d5e6f7081';

interface BatchResult {
  count: number;
}

describe('FollowsService', () => {
  const prisma = {
    user: { findUnique: jest.fn<Promise<{ id: string } | null>, [unknown]>() },
    follow: {
      createMany: jest.fn<Promise<BatchResult>, [unknown]>(),
      deleteMany: jest.fn<Promise<BatchResult>, [unknown]>(),
      count: jest.fn<Promise<number>, [unknown]>(),
    },
    // The transaction client is the same mock, so assertions see every call.
    $transaction: jest.fn<Promise<unknown>, [(tx: unknown) => Promise<unknown>]>(),
  };
  let service: FollowsService;

  beforeEach(async () => {
    jest.resetAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
    prisma.user.findUnique.mockResolvedValue({ id: OTHER_USER_ID });

    const moduleRef = await Test.createTestingModule({
      providers: [FollowsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(FollowsService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('follow', () => {
    it('inserts the follow idempotently and returns the follower count, in one transaction', async () => {
      prisma.follow.createMany.mockResolvedValue({ count: 1 });
      prisma.follow.count.mockResolvedValue(4);

      const result = await service.follow(USER_ID, OTHER_USER_ID);

      expect(result).toEqual({ isFollowing: true, followerCount: 4 });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.follow.createMany).toHaveBeenCalledWith({
        data: [{ followerId: USER_ID, followingId: OTHER_USER_ID }],
        skipDuplicates: true,
      });
      expect(prisma.follow.count).toHaveBeenCalledWith({ where: { followingId: OTHER_USER_ID } });
    });

    it('returns the same state when already following', async () => {
      prisma.follow.createMany.mockResolvedValue({ count: 0 });
      prisma.follow.count.mockResolvedValue(4);

      expect(await service.follow(USER_ID, OTHER_USER_ID)).toEqual({
        isFollowing: true,
        followerCount: 4,
      });
    });

    it('rejects following yourself with 400 before any query', async () => {
      const promise = service.follow(USER_ID, USER_ID);

      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      await expect(promise).rejects.toThrow(CANNOT_FOLLOW_SELF);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws 404 for an unknown user without inserting', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const promise = service.follow(USER_ID, OTHER_USER_ID);

      await expect(promise).rejects.toBeInstanceOf(NotFoundException);
      await expect(promise).rejects.toThrow(USER_NOT_FOUND);
      expect(prisma.follow.createMany).not.toHaveBeenCalled();
    });
  });

  describe('unfollow', () => {
    it('deletes the follow and returns the follower count, in one transaction', async () => {
      prisma.follow.deleteMany.mockResolvedValue({ count: 1 });
      prisma.follow.count.mockResolvedValue(3);

      const result = await service.unfollow(USER_ID, OTHER_USER_ID);

      expect(result).toEqual({ isFollowing: false, followerCount: 3 });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.follow.deleteMany).toHaveBeenCalledWith({
        where: { followerId: USER_ID, followingId: OTHER_USER_ID },
      });
    });

    it('is a no-op when not following', async () => {
      prisma.follow.deleteMany.mockResolvedValue({ count: 0 });
      prisma.follow.count.mockResolvedValue(0);

      expect(await service.unfollow(USER_ID, OTHER_USER_ID)).toEqual({
        isFollowing: false,
        followerCount: 0,
      });
    });

    it('rejects unfollowing yourself with 400 before any query', async () => {
      await expect(service.unfollow(USER_ID, USER_ID)).rejects.toThrow(CANNOT_FOLLOW_SELF);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws 404 for an unknown user without deleting', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.unfollow(USER_ID, OTHER_USER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.follow.deleteMany).not.toHaveBeenCalled();
    });
  });
});
