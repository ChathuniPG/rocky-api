import { BadRequestException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { decodeCursor, encodeCursor } from '../../common/pagination/cursor-pagination';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import { PrismaService } from '../../prisma/prisma.service';
import type { CommentRow } from './comment-query';
import { CommentsService } from './comments.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { COMMENT_NOT_FOUND, NOT_COMMENT_AUTHOR, POST_NOT_FOUND } from './posts.constants';

const USER_ID = '6f1c1b1e-8d5a-4a4e-9a51-2b3c4d5e6f70';
const OTHER_USER_ID = '7a2d2c2f-9e6b-4b5f-8a62-3c4d5e6f7081';
const POST_ID = '1c7f7b63-2d2f-4d54-8b30-2e2c303d4e5f';
const COMMENT_ID = '2d808c74-3e30-4e65-9c41-3f3d414e5f60';
const CREATED_AT = new Date('2026-11-06T10:00:00.123Z');

function commentRow(overrides: Partial<CommentRow> = {}): CommentRow {
  return {
    id: COMMENT_ID,
    postId: POST_ID,
    body: 'Nice',
    createdAt: CREATED_AT,
    author: { id: USER_ID, username: 'bob', displayName: 'Bob', avatarUrl: null },
    ...overrides,
  };
}

function pageQuery(limit: number, cursor?: string): PaginationQueryDto {
  const query = new PaginationQueryDto();
  query.limit = limit;
  query.cursor = cursor;
  return query;
}

function createDto(body: string): CreateCommentDto {
  const dto = new CreateCommentDto();
  dto.body = body;
  return dto;
}

describe('CommentsService', () => {
  const prisma = {
    post: {
      findUnique: jest.fn<Promise<{ id: string } | null>, [unknown]>(),
      update: jest.fn<Promise<unknown>, [unknown]>(),
      updateMany: jest.fn<Promise<{ count: number }>, [unknown]>(),
    },
    comment: {
      findMany: jest.fn<Promise<CommentRow[]>, [unknown]>(),
      findUnique: jest.fn<Promise<{ authorId: string; postId: string } | null>, [unknown]>(),
      create: jest.fn<Promise<CommentRow>, [unknown]>(),
      deleteMany: jest.fn<Promise<{ count: number }>, [unknown]>(),
    },
    // The transaction client is the same mock, so assertions see every call.
    $transaction: jest.fn<Promise<unknown>, [(tx: unknown) => Promise<unknown>]>(),
  };
  let service: CommentsService;

  beforeEach(async () => {
    jest.resetAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
    prisma.post.findUnique.mockResolvedValue({ id: POST_ID });

    const moduleRef = await Test.createTestingModule({
      providers: [CommentsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(CommentsService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('list', () => {
    it("queries the post's comments newest first with one extra row", async () => {
      prisma.comment.findMany.mockResolvedValue([]);

      const page = await service.list(POST_ID, pageQuery(15));

      expect(page).toEqual({ items: [], nextCursor: null });
      expect(prisma.comment.findMany).toHaveBeenCalledWith({
        where: { postId: POST_ID },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 16,
        select: expect.objectContaining({ author: expect.any(Object) }),
      });
    });

    it('applies the keyset condition of the cursor together with the post filter', async () => {
      prisma.comment.findMany.mockResolvedValue([]);
      const cursor = encodeCursor({ createdAt: CREATED_AT, id: COMMENT_ID });

      await service.list(POST_ID, pageQuery(2, cursor));

      expect(prisma.comment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            postId: POST_ID,
            OR: [
              { createdAt: { lt: CREATED_AT } },
              { createdAt: CREATED_AT, id: { lt: COMMENT_ID } },
            ],
          },
        }),
      );
    });

    it('maps rows with their author and returns a cursor when more rows exist', async () => {
      const ids = [COMMENT_ID, POST_ID, USER_ID];
      prisma.comment.findMany.mockResolvedValue(ids.map((id) => commentRow({ id })));

      const page = await service.list(POST_ID, pageQuery(2));

      expect(page.items).toEqual([
        {
          id: COMMENT_ID,
          postId: POST_ID,
          body: 'Nice',
          createdAt: CREATED_AT,
          author: { id: USER_ID, username: 'bob', displayName: 'Bob', avatarUrl: null },
        },
        expect.objectContaining({ id: POST_ID }),
      ]);
      expect(decodeCursor(page.nextCursor ?? undefined)).toEqual({
        createdAt: CREATED_AT,
        id: POST_ID,
      });
    });

    it('throws 404 for a missing post without listing', async () => {
      prisma.post.findUnique.mockResolvedValue(null);

      const promise = service.list(POST_ID, pageQuery(15));

      await expect(promise).rejects.toBeInstanceOf(NotFoundException);
      await expect(promise).rejects.toThrow(POST_NOT_FOUND);
      expect(prisma.comment.findMany).not.toHaveBeenCalled();
    });

    it('rejects an invalid cursor with 400 without querying', async () => {
      await expect(service.list(POST_ID, pageQuery(15, 'bad'))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.comment.findMany).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('creates the comment and increments comment_count in one transaction', async () => {
      prisma.comment.create.mockResolvedValue(commentRow());

      const result = await service.create(USER_ID, POST_ID, createDto('Nice'));

      expect(result).toMatchObject({ id: COMMENT_ID, body: 'Nice', author: { id: USER_ID } });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.comment.create).toHaveBeenCalledWith({
        data: { postId: POST_ID, authorId: USER_ID, body: 'Nice' },
        select: expect.objectContaining({ id: true }),
      });
      expect(prisma.post.update).toHaveBeenCalledWith({
        where: { id: POST_ID },
        data: { commentCount: { increment: 1 } },
        select: { id: true },
      });
    });

    it('throws 404 for a missing post, creating nothing', async () => {
      prisma.post.findUnique.mockResolvedValue(null);

      const promise = service.create(USER_ID, POST_ID, createDto('Nice'));

      await expect(promise).rejects.toThrow(POST_NOT_FOUND);
      expect(prisma.comment.create).not.toHaveBeenCalled();
      expect(prisma.post.update).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    beforeEach(() => {
      prisma.comment.findUnique.mockResolvedValue({ authorId: USER_ID, postId: POST_ID });
      prisma.comment.deleteMany.mockResolvedValue({ count: 1 });
      prisma.post.updateMany.mockResolvedValue({ count: 1 });
    });

    it('deletes the comment and decrements comment_count in one transaction', async () => {
      await service.delete(USER_ID, COMMENT_ID);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.comment.deleteMany).toHaveBeenCalledWith({ where: { id: COMMENT_ID } });
      expect(prisma.post.updateMany).toHaveBeenCalledWith({
        where: { id: POST_ID },
        data: { commentCount: { decrement: 1 } },
      });
    });

    it('does not decrement when a concurrent delete already removed the comment', async () => {
      prisma.comment.deleteMany.mockResolvedValue({ count: 0 });

      await service.delete(USER_ID, COMMENT_ID);

      expect(prisma.post.updateMany).not.toHaveBeenCalled();
    });

    it("rejects another user's comment with 403, deleting nothing", async () => {
      prisma.comment.findUnique.mockResolvedValue({ authorId: OTHER_USER_ID, postId: POST_ID });

      const promise = service.delete(USER_ID, COMMENT_ID);

      await expect(promise).rejects.toBeInstanceOf(ForbiddenException);
      await expect(promise).rejects.toThrow(NOT_COMMENT_AUTHOR);
      expect(prisma.comment.deleteMany).not.toHaveBeenCalled();
      expect(prisma.post.updateMany).not.toHaveBeenCalled();
    });

    it('throws 404 for a missing comment, deleting nothing', async () => {
      prisma.comment.findUnique.mockResolvedValue(null);

      const promise = service.delete(USER_ID, COMMENT_ID);

      await expect(promise).rejects.toBeInstanceOf(NotFoundException);
      await expect(promise).rejects.toThrow(COMMENT_NOT_FOUND);
      expect(prisma.comment.deleteMany).not.toHaveBeenCalled();
    });
  });
});
