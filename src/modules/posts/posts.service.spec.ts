import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  decodeCursor,
  encodeCursor,
  INVALID_CURSOR_MESSAGE,
} from '../../common/pagination/cursor-pagination';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import {
  FirebaseStorageService,
  type StorageObjectMetadata,
} from '../../firebase/firebase-storage.service';
import { FirebaseUnavailableError } from '../../firebase/firebase.errors';
import { Prisma } from '../../generated/prisma/client';
import { MediaType } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { CreatePostDto } from './dto/create-post.dto';
import type { PostRow } from './post-query';
import {
  INVALID_MEDIA_PATH,
  MEDIA_ALREADY_USED,
  MEDIA_NOT_FOUND,
  MEDIA_NOT_OWNED,
  POST_NOT_FOUND,
  UNSUPPORTED_MEDIA,
} from './posts.constants';
import { PostsService } from './posts.service';

const USER_ID = '6f1c1b1e-8d5a-4a4e-9a51-2b3c4d5e6f70';
const OTHER_USER_ID = '7a2d2c2f-9e6b-4b5f-8a62-3c4d5e6f7081';
const FILE_ID = '0b6f6a52-1c1e-4c43-9a2f-1d1b2f3c4d5e';
const POST_ID = '1c7f7b63-2d2f-4d54-8b30-2e2c303d4e5f';
const PNG_PATH = `posts/${USER_ID}/${FILE_ID}.png`;
const URL = 'https://firebasestorage.googleapis.com/v0/b/bucket/o/x?alt=media&token=t';
const CREATED_AT = new Date('2026-11-06T10:00:00.123Z');

function postRow(overrides: Partial<PostRow> = {}): PostRow {
  return {
    id: POST_ID,
    caption: 'hello',
    mediaUrl: URL,
    mediaType: MediaType.IMAGE,
    likeCount: 2,
    commentCount: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    author: { id: USER_ID, username: 'alice', displayName: 'Alice', avatarUrl: null },
    _count: { likes: 0, saves: 0 },
    ...overrides,
  };
}

function createDto(mediaPath: string, caption = 'hello'): CreatePostDto {
  const dto = new CreatePostDto();
  dto.mediaPath = mediaPath;
  dto.caption = caption;
  return dto;
}

function pageQuery(limit: number, cursor?: string): PaginationQueryDto {
  const query = new PaginationQueryDto();
  query.limit = limit;
  query.cursor = cursor;
  return query;
}

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('PostsService', () => {
  const prisma = {
    post: {
      create: jest.fn<Promise<PostRow>, [unknown]>(),
      findMany: jest.fn<Promise<PostRow[]>, [unknown]>(),
      findUnique: jest.fn<Promise<PostRow | { id: string } | null>, [unknown]>(),
    },
  };
  const storage = {
    getObjectMetadata: jest.fn<Promise<StorageObjectMetadata>, [string]>(),
    getDownloadUrl: jest.fn<Promise<string>, [string]>(),
  };
  let service: PostsService;

  beforeEach(async () => {
    jest.resetAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    prisma.post.findUnique.mockResolvedValue(null);
    prisma.post.create.mockResolvedValue(postRow());
    storage.getObjectMetadata.mockResolvedValue({
      exists: true,
      contentType: 'image/png',
      sizeBytes: 67,
    });
    storage.getDownloadUrl.mockResolvedValue(URL);

    const moduleRef = await Test.createTestingModule({
      providers: [
        PostsService,
        { provide: PrismaService, useValue: prisma },
        { provide: FirebaseStorageService, useValue: storage },
      ],
    }).compile();
    service = moduleRef.get(PostsService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('create', () => {
    it('creates the post with a server-side URL and the stored media type', async () => {
      const result = await service.create(USER_ID, createDto(PNG_PATH));

      expect(storage.getObjectMetadata).toHaveBeenCalledWith(PNG_PATH);
      expect(storage.getDownloadUrl).toHaveBeenCalledWith(PNG_PATH);
      expect(prisma.post.create).toHaveBeenCalledWith({
        data: {
          authorId: USER_ID,
          caption: 'hello',
          mediaPath: PNG_PATH,
          mediaUrl: URL,
          mediaType: MediaType.IMAGE,
        },
        select: expect.objectContaining({ id: true, author: expect.any(Object) }),
      });
      expect(result).toEqual({
        id: POST_ID,
        caption: 'hello',
        mediaUrl: URL,
        mediaType: MediaType.IMAGE,
        likeCount: 2,
        commentCount: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        author: { id: USER_ID, username: 'alice', displayName: 'Alice', avatarUrl: null },
        likedByMe: false,
        savedByMe: false,
      });
    });

    it('takes VIDEO from the stored content type of an MP4', async () => {
      const path = `posts/${USER_ID}/${FILE_ID}.mp4`;
      storage.getObjectMetadata.mockResolvedValue({
        exists: true,
        contentType: 'video/mp4',
        sizeBytes: 1000,
      });

      await service.create(USER_ID, createDto(path));

      expect(prisma.post.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ mediaType: MediaType.VIDEO }) }),
      );
    });

    it('stores an empty caption as is', async () => {
      await service.create(USER_ID, createDto(PNG_PATH, ''));

      expect(prisma.post.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ caption: '' }) }),
      );
    });

    it.each([
      ['an avatar path', `avatars/${USER_ID}/${FILE_ID}.png`],
      ['traversal', `posts/${USER_ID}/../${FILE_ID}.png`],
      ['a disallowed extension', `posts/${USER_ID}/${FILE_ID}.gif`],
      ['a URL', URL],
    ])('rejects %s with 400 before any lookup', async (_name, path) => {
      const promise = service.create(USER_ID, createDto(path));

      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      await expect(promise).rejects.toThrow(INVALID_MEDIA_PATH);
      expect(prisma.post.findUnique).not.toHaveBeenCalled();
      expect(storage.getObjectMetadata).not.toHaveBeenCalled();
    });

    it("rejects another user's upload with 403 before any lookup", async () => {
      const promise = service.create(OTHER_USER_ID, createDto(PNG_PATH));

      await expect(promise).rejects.toBeInstanceOf(ForbiddenException);
      await expect(promise).rejects.toThrow(MEDIA_NOT_OWNED);
      expect(storage.getObjectMetadata).not.toHaveBeenCalled();
    });

    it('rejects an upload already used by a post with 409, without calling Storage', async () => {
      prisma.post.findUnique.mockResolvedValue({ id: POST_ID });

      const promise = service.create(USER_ID, createDto(PNG_PATH));

      await expect(promise).rejects.toBeInstanceOf(ConflictException);
      await expect(promise).rejects.toThrow(MEDIA_ALREADY_USED);
      expect(prisma.post.findUnique).toHaveBeenCalledWith({
        where: { mediaPath: PNG_PATH },
        select: { id: true },
      });
      expect(storage.getObjectMetadata).not.toHaveBeenCalled();
    });

    it('rejects a path with no Storage object with 400', async () => {
      storage.getObjectMetadata.mockResolvedValue({ exists: false });

      const promise = service.create(USER_ID, createDto(PNG_PATH));

      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      await expect(promise).rejects.toThrow(MEDIA_NOT_FOUND);
      expect(prisma.post.create).not.toHaveBeenCalled();
    });

    it.each([
      ['an unsupported content type', 'image/gif'],
      ['no content type', undefined],
      ['a content type that does not match the extension', 'image/jpeg'],
    ])('rejects an object with %s with 400', async (_name, contentType) => {
      storage.getObjectMetadata.mockResolvedValue({ exists: true, contentType, sizeBytes: 1 });

      const promise = service.create(USER_ID, createDto(PNG_PATH));

      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      await expect(promise).rejects.toThrow(UNSUPPORTED_MEDIA);
      expect(storage.getDownloadUrl).not.toHaveBeenCalled();
      expect(prisma.post.create).not.toHaveBeenCalled();
    });

    it('maps a unique violation on insert (concurrent reuse) to 409', async () => {
      prisma.post.create.mockRejectedValue(uniqueViolation());

      const promise = service.create(USER_ID, createDto(PNG_PATH));

      await expect(promise).rejects.toBeInstanceOf(ConflictException);
      await expect(promise).rejects.toThrow(MEDIA_ALREADY_USED);
    });

    it('passes a Storage failure through without inserting', async () => {
      storage.getObjectMetadata.mockRejectedValue(new FirebaseUnavailableError());

      await expect(service.create(USER_ID, createDto(PNG_PATH))).rejects.toBeInstanceOf(
        FirebaseUnavailableError,
      );
      expect(prisma.post.create).not.toHaveBeenCalled();
    });
  });

  describe('getFeed', () => {
    it('queries newest first with one extra row and no cursor condition on page one', async () => {
      prisma.post.findMany.mockResolvedValue([]);

      const page = await service.getFeed(USER_ID, pageQuery(15));

      expect(page).toEqual({ items: [], nextCursor: null });
      expect(prisma.post.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 16,
        select: expect.objectContaining({
          _count: {
            select: {
              likes: { where: { userId: USER_ID } },
              saves: { where: { userId: USER_ID } },
            },
          },
        }),
      });
    });

    it('applies the keyset condition of the cursor', async () => {
      prisma.post.findMany.mockResolvedValue([]);
      const cursor = encodeCursor({ createdAt: CREATED_AT, id: POST_ID });

      await service.getFeed(USER_ID, pageQuery(2, cursor));

      expect(prisma.post.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [{ createdAt: { lt: CREATED_AT } }, { createdAt: CREATED_AT, id: { lt: POST_ID } }],
          },
        }),
      );
    });

    it('returns a next cursor pointing at the last post when more rows exist', async () => {
      const ids = [
        '3e919d85-4f41-4f76-8d52-404152536471',
        '2d808c74-3e30-4e65-9c41-3f3d414e5f60',
        POST_ID,
      ];
      // Identical timestamps: the id is the tie-breaker.
      prisma.post.findMany.mockResolvedValue(ids.map((id) => postRow({ id })));

      const page = await service.getFeed(USER_ID, pageQuery(2));

      expect(page.items.map((item) => item.id)).toEqual(ids.slice(0, 2));
      expect(decodeCursor(page.nextCursor ?? undefined)).toEqual({
        createdAt: CREATED_AT,
        id: ids[1],
      });
    });

    it('maps the viewer counts to likedByMe and savedByMe', async () => {
      prisma.post.findMany.mockResolvedValue([
        postRow({ _count: { likes: 1, saves: 0 } }),
        postRow({ id: FILE_ID, _count: { likes: 0, saves: 1 } }),
      ]);

      const page = await service.getFeed(USER_ID, pageQuery(15));

      expect(page.items.map(({ likedByMe, savedByMe }) => ({ likedByMe, savedByMe }))).toEqual([
        { likedByMe: true, savedByMe: false },
        { likedByMe: false, savedByMe: true },
      ]);
    });

    it('rejects an invalid cursor with 400 without querying', async () => {
      const promise = service.getFeed(USER_ID, pageQuery(15, 'not-a-cursor'));

      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      await expect(promise).rejects.toThrow(INVALID_CURSOR_MESSAGE);
      expect(prisma.post.findMany).not.toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('returns the post with the viewer flags', async () => {
      prisma.post.findUnique.mockResolvedValue(postRow({ _count: { likes: 1, saves: 1 } }));

      const result = await service.findById(OTHER_USER_ID, POST_ID);

      expect(result).toMatchObject({ id: POST_ID, likedByMe: true, savedByMe: true });
      expect(prisma.post.findUnique).toHaveBeenCalledWith({
        where: { id: POST_ID },
        select: expect.objectContaining({
          _count: {
            select: {
              likes: { where: { userId: OTHER_USER_ID } },
              saves: { where: { userId: OTHER_USER_ID } },
            },
          },
        }),
      });
    });

    it('throws 404 for a missing post', async () => {
      const promise = service.findById(USER_ID, POST_ID);

      await expect(promise).rejects.toBeInstanceOf(NotFoundException);
      await expect(promise).rejects.toThrow(POST_NOT_FOUND);
    });
  });
});
