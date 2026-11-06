import { BadRequestException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { buildUser } from '../../../test/fixtures/user.fixture';
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
import type { User } from '../../generated/prisma/client';
import { MediaType } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import type { PostRow } from '../posts/post-query';
import { UpdateProfileDto } from './dto/update-profile.dto';
import type { ProfileRow } from './user-query';
import {
  AVATAR_NOT_FOUND,
  AVATAR_NOT_OWNED,
  EMPTY_PROFILE_UPDATE,
  INVALID_AVATAR_PATH,
  UNSUPPORTED_AVATAR,
  USER_NOT_FOUND,
} from './users.constants';
import { UsersService } from './users.service';

const USER_ID = '6f1c1b1e-8d5a-4a4e-9a51-2b3c4d5e6f70';
const OTHER_USER_ID = '7a2d2c2f-9e6b-4b5f-8a62-3c4d5e6f7081';
const FILE_ID = '0b6f6a52-1c1e-4c43-9a2f-1d1b2f3c4d5e';
const OLD_FILE_ID = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const POST_ID = '1c7f7b63-2d2f-4d54-8b30-2e2c303d4e5f';
const AVATAR_PATH = `avatars/${USER_ID}/${FILE_ID}.png`;
const OLD_AVATAR_PATH = `avatars/${USER_ID}/${OLD_FILE_ID}.jpg`;
const URL = 'https://firebasestorage.googleapis.com/v0/b/bucket/o/x?alt=media&token=t';
const CREATED_AT = new Date('2026-11-06T10:00:00.123Z');

function profileRow(overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    id: OTHER_USER_ID,
    username: 'bob',
    displayName: 'Bob',
    bio: 'Hello',
    avatarUrl: null,
    createdAt: CREATED_AT,
    _count: { posts: 3, followers: 5, following: 7 },
    followers: [],
    ...overrides,
  };
}

function postRow(id: string): PostRow {
  return {
    id,
    caption: '',
    mediaUrl: URL,
    mediaType: MediaType.IMAGE,
    likeCount: 0,
    commentCount: 0,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    author: { id: OTHER_USER_ID, username: 'bob', displayName: 'Bob', avatarUrl: null },
    _count: { likes: 0, saves: 1 },
  };
}

function updateDto(fields: Partial<UpdateProfileDto>): UpdateProfileDto {
  return Object.assign(new UpdateProfileDto(), fields);
}

function pageQuery(limit: number, cursor?: string): PaginationQueryDto {
  const query = new PaginationQueryDto();
  query.limit = limit;
  query.cursor = cursor;
  return query;
}

interface SaveRow {
  createdAt: Date;
  postId: string;
  post: PostRow;
}

describe('UsersService', () => {
  const prisma = {
    user: {
      findUnique: jest.fn<Promise<ProfileRow | { id: string } | null>, [{ select: object }]>(),
      update: jest.fn<Promise<User>, [{ data: Record<string, unknown> }]>(),
    },
    post: { findMany: jest.fn<Promise<PostRow[]>, [unknown]>() },
    save: { findMany: jest.fn<Promise<SaveRow[]>, [unknown]>() },
  };
  const storage = {
    getObjectMetadata: jest.fn<Promise<StorageObjectMetadata>, [string]>(),
    getDownloadUrl: jest.fn<Promise<string>, [string]>(),
    deleteObject: jest.fn<Promise<void>, [string]>(),
  };
  let service: UsersService;

  beforeEach(async () => {
    jest.resetAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    // Echoes the written fields back, as PostgreSQL would; Prisma skips undefined ones.
    prisma.user.update.mockImplementation(({ data }) => {
      const written = Object.entries(data).filter(([, value]) => value !== undefined);
      return Promise.resolve(buildUser(Object.fromEntries(written) as Partial<User>));
    });
    storage.getObjectMetadata.mockResolvedValue({
      exists: true,
      contentType: 'image/png',
      sizeBytes: 67,
    });
    storage.getDownloadUrl.mockResolvedValue(URL);
    storage.deleteObject.mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: FirebaseStorageService, useValue: storage },
      ],
    }).compile();
    service = moduleRef.get(UsersService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getProfile', () => {
    it("returns another user's public profile with counts, without private fields", async () => {
      prisma.user.findUnique.mockResolvedValue(profileRow());

      const result = await service.getProfile(USER_ID, 'bob');

      expect(result).toEqual({
        id: OTHER_USER_ID,
        username: 'bob',
        displayName: 'Bob',
        bio: 'Hello',
        avatarUrl: null,
        createdAt: CREATED_AT,
        postCount: 3,
        followerCount: 5,
        followingCount: 7,
        isFollowing: false,
        isMe: false,
      });
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { username: 'bob' },
        select: expect.objectContaining({
          followers: { where: { followerId: USER_ID }, select: { followerId: true }, take: 1 },
        }),
      });
    });

    it('never selects email, firebaseUid or avatarPath', async () => {
      prisma.user.findUnique.mockResolvedValue(profileRow());

      await service.getProfile(USER_ID, 'bob');

      const [{ select }] = prisma.user.findUnique.mock.calls[0];
      expect(select).not.toHaveProperty('email');
      expect(select).not.toHaveProperty('firebaseUid');
      expect(select).not.toHaveProperty('avatarPath');
    });

    it('sets isFollowing when the viewer follows the user', async () => {
      prisma.user.findUnique.mockResolvedValue(
        profileRow({ followers: [{ followerId: USER_ID }] }),
      );

      expect(await service.getProfile(USER_ID, 'bob')).toMatchObject({ isFollowing: true });
    });

    it('sets isMe on your own profile', async () => {
      prisma.user.findUnique.mockResolvedValue(profileRow({ id: USER_ID }));

      expect(await service.getProfile(USER_ID, 'alice')).toMatchObject({ isMe: true });
    });

    it('throws 404 for an unknown username', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const promise = service.getProfile(USER_ID, 'nobody');

      await expect(promise).rejects.toBeInstanceOf(NotFoundException);
      await expect(promise).rejects.toThrow(USER_NOT_FOUND);
    });
  });

  describe('updateProfile', () => {
    it('rejects an update without any field with 400', async () => {
      const promise = service.updateProfile(buildUser(), updateDto({}));

      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      await expect(promise).rejects.toThrow(EMPTY_PROFILE_UPDATE);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('writes only the fields that were sent and returns the /auth/me shape', async () => {
      const result = await service.updateProfile(
        buildUser(),
        updateDto({ displayName: 'Alicia', notificationsEnabled: false, language: 'si' }),
      );

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: {
          displayName: 'Alicia',
          bio: undefined,
          notificationsEnabled: false,
          language: 'si',
        },
      });
      expect(result).toMatchObject({
        id: USER_ID,
        email: 'alice@example.com',
        displayName: 'Alicia',
        notificationsEnabled: false,
        language: 'si',
      });
      expect(result).not.toHaveProperty('firebaseUid');
      expect(result).not.toHaveProperty('avatarPath');
      expect(storage.getObjectMetadata).not.toHaveBeenCalled();
    });

    it.each([
      ['an empty string', ''],
      ['null', null],
    ])('clears the bio when it is %s', async (_name, bio) => {
      await service.updateProfile(buildUser({ bio: 'old' }), updateDto({ bio }));

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ bio: null }) }),
      );
    });

    it('sets a first avatar with a server-generated URL and deletes nothing', async () => {
      const result = await service.updateProfile(
        buildUser(),
        updateDto({ avatarPath: AVATAR_PATH }),
      );

      expect(storage.getObjectMetadata).toHaveBeenCalledWith(AVATAR_PATH);
      expect(storage.getDownloadUrl).toHaveBeenCalledWith(AVATAR_PATH);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ avatarPath: AVATAR_PATH, avatarUrl: URL }),
        }),
      );
      expect(result.avatarUrl).toBe(URL);
      expect(storage.deleteObject).not.toHaveBeenCalled();
    });

    it('replaces an avatar: updates the row, then deletes the old object', async () => {
      const user = buildUser({ avatarPath: OLD_AVATAR_PATH, avatarUrl: 'https://old' });

      await service.updateProfile(user, updateDto({ avatarPath: AVATAR_PATH }));

      expect(storage.deleteObject).toHaveBeenCalledWith(OLD_AVATAR_PATH);
      expect(prisma.user.update.mock.invocationCallOrder[0]).toBeLessThan(
        storage.deleteObject.mock.invocationCallOrder[0],
      );
    });

    it('removes the avatar with null and deletes the old object', async () => {
      const user = buildUser({ avatarPath: OLD_AVATAR_PATH, avatarUrl: 'https://old' });

      await service.updateProfile(user, updateDto({ avatarPath: null }));

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ avatarPath: null, avatarUrl: null }),
        }),
      );
      expect(storage.getObjectMetadata).not.toHaveBeenCalled();
      expect(storage.deleteObject).toHaveBeenCalledWith(OLD_AVATAR_PATH);
    });

    it('treats re-sending the current avatar path as no change, deleting nothing', async () => {
      const user = buildUser({ avatarPath: AVATAR_PATH, avatarUrl: URL });

      await service.updateProfile(user, updateDto({ avatarPath: AVATAR_PATH, bio: 'hi' }));

      const [{ data }] = prisma.user.update.mock.calls[0];
      expect(data).not.toHaveProperty('avatarPath');
      expect(storage.getObjectMetadata).not.toHaveBeenCalled();
      expect(storage.deleteObject).not.toHaveBeenCalled();
    });

    it('treats removing an avatar you do not have as no change', async () => {
      await service.updateProfile(buildUser(), updateDto({ avatarPath: null }));

      const [{ data }] = prisma.user.update.mock.calls[0];
      expect(data).not.toHaveProperty('avatarPath');
      expect(storage.deleteObject).not.toHaveBeenCalled();
    });

    it('still succeeds, and logs the orphan, when deleting the old avatar fails', async () => {
      storage.deleteObject.mockRejectedValue(new FirebaseUnavailableError());
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const user = buildUser({ avatarPath: OLD_AVATAR_PATH });

      await expect(
        service.updateProfile(user, updateDto({ avatarPath: AVATAR_PATH })),
      ).resolves.toMatchObject({ avatarUrl: URL });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(OLD_AVATAR_PATH));
    });

    it.each([
      ['a post media path', `posts/${USER_ID}/${FILE_ID}.png`],
      ['traversal', `avatars/${USER_ID}/../${FILE_ID}.png`],
      ['a video extension', `avatars/${USER_ID}/${FILE_ID}.mp4`],
      ['a URL', URL],
    ])('rejects %s with 400 before any lookup', async (_name, avatarPath) => {
      const promise = service.updateProfile(buildUser(), updateDto({ avatarPath }));

      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      await expect(promise).rejects.toThrow(INVALID_AVATAR_PATH);
      expect(storage.getObjectMetadata).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("rejects another user's avatar upload with 403 before any lookup", async () => {
      const avatarPath = `avatars/${OTHER_USER_ID}/${FILE_ID}.png`;

      const promise = service.updateProfile(buildUser(), updateDto({ avatarPath }));

      await expect(promise).rejects.toBeInstanceOf(ForbiddenException);
      await expect(promise).rejects.toThrow(AVATAR_NOT_OWNED);
      expect(storage.getObjectMetadata).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects a path with no Storage object with 400', async () => {
      storage.getObjectMetadata.mockResolvedValue({ exists: false });

      const promise = service.updateProfile(buildUser(), updateDto({ avatarPath: AVATAR_PATH }));

      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      await expect(promise).rejects.toThrow(AVATAR_NOT_FOUND);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it.each([
      ['a video content type', 'video/mp4'],
      ['an unsupported content type', 'image/gif'],
      ['no content type', undefined],
      ['a content type that does not match the extension', 'image/jpeg'],
    ])('rejects an object with %s with 400', async (_name, contentType) => {
      storage.getObjectMetadata.mockResolvedValue({ exists: true, contentType, sizeBytes: 1 });

      const promise = service.updateProfile(buildUser(), updateDto({ avatarPath: AVATAR_PATH }));

      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      await expect(promise).rejects.toThrow(UNSUPPORTED_AVATAR);
      expect(storage.getDownloadUrl).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('does not delete the old avatar when the row update fails', async () => {
      prisma.user.update.mockRejectedValue(new Error('database down'));
      const user = buildUser({ avatarPath: OLD_AVATAR_PATH });

      await expect(
        service.updateProfile(user, updateDto({ avatarPath: AVATAR_PATH })),
      ).rejects.toThrow('database down');
      expect(storage.deleteObject).not.toHaveBeenCalled();
    });
  });

  describe('listUserPosts', () => {
    it("queries the user's posts newest first with the viewer's flags", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: OTHER_USER_ID });
      prisma.post.findMany.mockResolvedValue([postRow(POST_ID)]);
      const cursor = encodeCursor({ createdAt: CREATED_AT, id: POST_ID });

      const page = await service.listUserPosts(USER_ID, 'bob', pageQuery(2, cursor));

      expect(page).toMatchObject({ items: [{ id: POST_ID, savedByMe: true }], nextCursor: null });
      expect(prisma.post.findMany).toHaveBeenCalledWith({
        where: {
          authorId: OTHER_USER_ID,
          OR: [{ createdAt: { lt: CREATED_AT } }, { createdAt: CREATED_AT, id: { lt: POST_ID } }],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 3,
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

    it('throws 404 for an unknown username without querying posts', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.listUserPosts(USER_ID, 'nobody', pageQuery(15))).rejects.toThrow(
        USER_NOT_FOUND,
      );
      expect(prisma.post.findMany).not.toHaveBeenCalled();
    });

    it('rejects an invalid cursor with 400 before any query', async () => {
      const promise = service.listUserPosts(USER_ID, 'bob', pageQuery(15, 'nope'));

      await expect(promise).rejects.toThrow(INVALID_CURSOR_MESSAGE);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('listSavedPosts', () => {
    const ids = [
      '3e919d85-4f41-4f76-8d52-404152536471',
      '2d808c74-3e30-4e65-9c41-3f3d414e5f60',
      POST_ID,
    ];

    it("queries the caller's saves by save time, with post_id as the tie-breaker", async () => {
      prisma.save.findMany.mockResolvedValue([]);

      const page = await service.listSavedPosts(USER_ID, pageQuery(15));

      expect(page).toEqual({ items: [], nextCursor: null });
      expect(prisma.save.findMany).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        orderBy: [{ createdAt: 'desc' }, { postId: 'desc' }],
        take: 16,
        select: {
          createdAt: true,
          postId: true,
          post: { select: expect.objectContaining({ id: true }) },
        },
      });
    });

    it('applies the cursor to the save time and the post ID', async () => {
      prisma.save.findMany.mockResolvedValue([]);
      const cursor = encodeCursor({ createdAt: CREATED_AT, id: POST_ID });

      await service.listSavedPosts(USER_ID, pageQuery(2, cursor));

      expect(prisma.save.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: USER_ID,
            OR: [
              { createdAt: { lt: CREATED_AT } },
              { createdAt: CREATED_AT, postId: { lt: POST_ID } },
            ],
          },
        }),
      );
    });

    it('returns the posts in save order, with a cursor of the last save time and post ID', async () => {
      const savedAt = new Date('2026-11-06T12:00:00.456Z');
      prisma.save.findMany.mockResolvedValue(
        ids.map((id) => ({ createdAt: savedAt, postId: id, post: postRow(id) })),
      );

      const page = await service.listSavedPosts(USER_ID, pageQuery(2));

      expect(page.items.map((item) => item.id)).toEqual(ids.slice(0, 2));
      // The save time, not the post's own created_at.
      expect(decodeCursor(page.nextCursor ?? undefined)).toEqual({
        createdAt: savedAt,
        id: ids[1],
      });
    });

    it('rejects an invalid cursor with 400 without querying', async () => {
      const promise = service.listSavedPosts(USER_ID, pageQuery(15, 'nope'));

      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.save.findMany).not.toHaveBeenCalled();
    });
  });
});
