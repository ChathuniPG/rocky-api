import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { PostEngagementService } from './post-engagement.service';
import { POST_NOT_FOUND } from './posts.constants';

const USER_ID = '6f1c1b1e-8d5a-4a4e-9a51-2b3c4d5e6f70';
const POST_ID = '1c7f7b63-2d2f-4d54-8b30-2e2c303d4e5f';

interface BatchResult {
  count: number;
}

describe('PostEngagementService', () => {
  const prisma = {
    post: {
      findUnique: jest.fn<Promise<{ id: string } | { likeCount: number } | null>, [unknown]>(),
      update: jest.fn<Promise<{ likeCount: number }>, [unknown]>(),
    },
    like: {
      createMany: jest.fn<Promise<BatchResult>, [unknown]>(),
      deleteMany: jest.fn<Promise<BatchResult>, [unknown]>(),
    },
    save: {
      createMany: jest.fn<Promise<BatchResult>, [unknown]>(),
      deleteMany: jest.fn<Promise<BatchResult>, [unknown]>(),
    },
    // The transaction client is the same mock, so assertions see every call.
    $transaction: jest.fn<Promise<unknown>, [(tx: unknown) => Promise<unknown>]>(),
  };
  let service: PostEngagementService;

  beforeEach(async () => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((callback) => callback(prisma));

    const moduleRef = await Test.createTestingModule({
      providers: [PostEngagementService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(PostEngagementService);
  });

  /** The post exists; reads of like_count return `likeCount`. */
  function givenPost(likeCount: number): void {
    prisma.post.findUnique.mockImplementation((args) =>
      Promise.resolve(JSON.stringify(args).includes('likeCount') ? { likeCount } : { id: POST_ID }),
    );
  }

  describe('like', () => {
    it('inserts the like and increments like_count atomically, in a transaction', async () => {
      givenPost(4);
      prisma.like.createMany.mockResolvedValue({ count: 1 });
      prisma.post.update.mockResolvedValue({ likeCount: 5 });

      const result = await service.like(USER_ID, POST_ID);

      expect(result).toEqual({ likedByMe: true, likeCount: 5 });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.like.createMany).toHaveBeenCalledWith({
        data: [{ userId: USER_ID, postId: POST_ID }],
        skipDuplicates: true,
      });
      expect(prisma.post.update).toHaveBeenCalledWith({
        where: { id: POST_ID },
        data: { likeCount: { increment: 1 } },
        select: { likeCount: true },
      });
    });

    it('does not increment when the post is already liked, and returns the current count', async () => {
      givenPost(5);
      prisma.like.createMany.mockResolvedValue({ count: 0 });

      const result = await service.like(USER_ID, POST_ID);

      expect(result).toEqual({ likedByMe: true, likeCount: 5 });
      expect(prisma.post.update).not.toHaveBeenCalled();
    });
  });

  describe('unlike', () => {
    it('deletes the like and decrements like_count atomically', async () => {
      givenPost(5);
      prisma.like.deleteMany.mockResolvedValue({ count: 1 });
      prisma.post.update.mockResolvedValue({ likeCount: 4 });

      const result = await service.unlike(USER_ID, POST_ID);

      expect(result).toEqual({ likedByMe: false, likeCount: 4 });
      expect(prisma.like.deleteMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, postId: POST_ID },
      });
      expect(prisma.post.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { likeCount: { increment: -1 } } }),
      );
    });

    it('does not decrement when the post is not liked, so the count never goes negative', async () => {
      givenPost(0);
      prisma.like.deleteMany.mockResolvedValue({ count: 0 });

      const result = await service.unlike(USER_ID, POST_ID);

      expect(result).toEqual({ likedByMe: false, likeCount: 0 });
      expect(prisma.post.update).not.toHaveBeenCalled();
    });
  });

  it('like, like, unlike, unlike counts exactly one like and ends at 0', async () => {
    // A tiny in-memory model of the likes table and the counter.
    let liked = false;
    let likeCount = 0;
    prisma.post.findUnique.mockImplementation(() => Promise.resolve({ id: POST_ID, likeCount }));
    prisma.like.createMany.mockImplementation(() => {
      const count = liked ? 0 : 1;
      liked = true;
      return Promise.resolve({ count });
    });
    prisma.like.deleteMany.mockImplementation(() => {
      const count = liked ? 1 : 0;
      liked = false;
      return Promise.resolve({ count });
    });
    prisma.post.update.mockImplementation((args) => {
      likeCount += JSON.stringify(args).includes('"increment":1') ? 1 : -1;
      return Promise.resolve({ likeCount });
    });

    const results = [
      await service.like(USER_ID, POST_ID),
      await service.like(USER_ID, POST_ID),
      await service.unlike(USER_ID, POST_ID),
      await service.unlike(USER_ID, POST_ID),
    ];

    expect(results).toEqual([
      { likedByMe: true, likeCount: 1 },
      { likedByMe: true, likeCount: 1 },
      { likedByMe: false, likeCount: 0 },
      { likedByMe: false, likeCount: 0 },
    ]);
    expect(prisma.post.update).toHaveBeenCalledTimes(2);
  });

  describe('save and unsave', () => {
    beforeEach(() => givenPost(0));

    it.each([1, 0])('save returns savedByMe true when %i rows are inserted', async (count) => {
      prisma.save.createMany.mockResolvedValue({ count });

      await expect(service.save(USER_ID, POST_ID)).resolves.toEqual({ savedByMe: true });
      expect(prisma.save.createMany).toHaveBeenCalledWith({
        data: [{ userId: USER_ID, postId: POST_ID }],
        skipDuplicates: true,
      });
      expect(prisma.post.update).not.toHaveBeenCalled();
    });

    it.each([1, 0])('unsave returns savedByMe false when %i rows are deleted', async (count) => {
      prisma.save.deleteMany.mockResolvedValue({ count });

      await expect(service.unsave(USER_ID, POST_ID)).resolves.toEqual({ savedByMe: false });
      expect(prisma.save.deleteMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, postId: POST_ID },
      });
      expect(prisma.post.update).not.toHaveBeenCalled();
    });
  });

  describe('missing post', () => {
    beforeEach(() => {
      prisma.post.findUnique.mockResolvedValue(null);
    });

    it.each(['like', 'unlike', 'save', 'unsave'] as const)(
      '%s throws 404 "Post not found" and changes nothing',
      async (method) => {
        const promise = service[method](USER_ID, POST_ID);

        await expect(promise).rejects.toBeInstanceOf(NotFoundException);
        await expect(promise).rejects.toThrow(POST_NOT_FOUND);
        expect(prisma.like.createMany).not.toHaveBeenCalled();
        expect(prisma.like.deleteMany).not.toHaveBeenCalled();
        expect(prisma.save.createMany).not.toHaveBeenCalled();
        expect(prisma.save.deleteMany).not.toHaveBeenCalled();
        expect(prisma.post.update).not.toHaveBeenCalled();
      },
    );
  });
});
