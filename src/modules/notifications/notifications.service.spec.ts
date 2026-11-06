import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { decodeCursor, encodeCursor } from '../../common/pagination/cursor-pagination';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import type { Prisma } from '../../generated/prisma/client';
import { MediaType, NotificationType } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import type { NotificationRow } from './notification-query';
import { NOTIFICATION_NOT_FOUND } from './notifications.constants';
import { type NewNotification, NotificationsService } from './notifications.service';

const ACTOR_ID = '6f1c1b1e-8d5a-4a4e-9a51-2b3c4d5e6f70';
const RECIPIENT_ID = '7a2d2c2f-9e6b-4b5f-8a62-3c4d5e6f7081';
const POST_ID = '1c7f7b63-2d2f-4d54-8b30-2e2c303d4e5f';
const COMMENT_ID = '2d808c74-3e30-4e65-9c41-3f3d414e5f60';
const NOTIFICATION_ID = '3e919d85-4f41-4f76-8d52-404e525f6071';
const CREATED_AT = new Date('2026-11-07T10:00:00.123Z');

const ACTOR = { id: ACTOR_ID, username: 'bob', displayName: 'Bob', avatarUrl: null };

function notificationRow(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: NOTIFICATION_ID,
    type: NotificationType.COMMENT,
    isRead: false,
    createdAt: CREATED_AT,
    actor: ACTOR,
    post: { id: POST_ID, mediaUrl: 'https://example.com/m.png', mediaType: MediaType.IMAGE },
    comment: { id: COMMENT_ID, body: 'Nice' },
    ...overrides,
  };
}

function pageQuery(limit: number, cursor?: string): PaginationQueryDto {
  const query = new PaginationQueryDto();
  query.limit = limit;
  query.cursor = cursor;
  return query;
}

describe('NotificationsService', () => {
  const tx = {
    user: {
      findUnique: jest.fn<Promise<{ notificationsEnabled: boolean } | null>, [unknown]>(),
    },
    notification: {
      create: jest.fn<Promise<{ id: string }>, [unknown]>(),
      deleteMany: jest.fn<Promise<{ count: number }>, [unknown]>(),
      findMany: jest.fn<Promise<NotificationRow[]>, [unknown]>(),
      count: jest.fn<Promise<number>, [unknown]>(),
      updateMany: jest.fn<Promise<{ count: number }>, [unknown]>(),
    },
  };
  let client: Prisma.TransactionClient;
  let service: NotificationsService;

  beforeEach(async () => {
    jest.resetAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    tx.user.findUnique.mockResolvedValue({ notificationsEnabled: true });
    tx.notification.create.mockResolvedValue({ id: NOTIFICATION_ID });

    const moduleRef = await Test.createTestingModule({
      // The same mock is the injected PrismaService and, read back from the container
      // (typed, without an unsafe assertion), the transaction client passed to create.
      providers: [NotificationsService, { provide: PrismaService, useValue: tx }],
    }).compile();
    service = moduleRef.get(NotificationsService);
    client = moduleRef.get(PrismaService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('create', () => {
    const inputs: NewNotification[] = [
      {
        type: NotificationType.LIKE,
        actorId: ACTOR_ID,
        recipientId: RECIPIENT_ID,
        postId: POST_ID,
      },
      {
        type: NotificationType.COMMENT,
        actorId: ACTOR_ID,
        recipientId: RECIPIENT_ID,
        postId: POST_ID,
        commentId: COMMENT_ID,
      },
      { type: NotificationType.FOLLOW, actorId: ACTOR_ID, recipientId: RECIPIENT_ID },
    ];

    it.each(inputs)('writes a $type notification with exactly the given fields', async (input) => {
      await service.create(client, input);

      expect(tx.user.findUnique).toHaveBeenCalledWith({
        where: { id: RECIPIENT_ID },
        select: { notificationsEnabled: true },
      });
      expect(tx.notification.create).toHaveBeenCalledWith({
        data: input,
        select: { id: true },
      });
    });

    it('never notifies users of their own actions, without any query', async () => {
      await service.create(client, {
        type: NotificationType.LIKE,
        actorId: ACTOR_ID,
        recipientId: ACTOR_ID,
        postId: POST_ID,
      });

      expect(tx.user.findUnique).not.toHaveBeenCalled();
      expect(tx.notification.create).not.toHaveBeenCalled();
    });

    it('creates nothing when the recipient turned notifications off (FR-SET-02)', async () => {
      tx.user.findUnique.mockResolvedValue({ notificationsEnabled: false });

      await service.create(client, inputs[2]);

      expect(tx.notification.create).not.toHaveBeenCalled();
    });

    it('creates nothing when the recipient no longer exists', async () => {
      tx.user.findUnique.mockResolvedValue(null);

      await service.create(client, inputs[0]);

      expect(tx.notification.create).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it("queries only the user's notifications, newest first, with one extra row", async () => {
      tx.notification.findMany.mockResolvedValue([]);

      const page = await service.list(RECIPIENT_ID, pageQuery(15));

      expect(page).toEqual({ items: [], nextCursor: null });
      expect(tx.notification.findMany).toHaveBeenCalledWith({
        where: { recipientId: RECIPIENT_ID },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 16,
        select: expect.objectContaining({ actor: expect.any(Object) }),
      });
    });

    it('applies the keyset condition of the cursor together with the recipient filter', async () => {
      tx.notification.findMany.mockResolvedValue([]);
      const cursor = encodeCursor({ createdAt: CREATED_AT, id: NOTIFICATION_ID });

      await service.list(RECIPIENT_ID, pageQuery(2, cursor));

      expect(tx.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            recipientId: RECIPIENT_ID,
            OR: [
              { createdAt: { lt: CREATED_AT } },
              { createdAt: CREATED_AT, id: { lt: NOTIFICATION_ID } },
            ],
          },
        }),
      );
    });

    it('maps actor, post and comment, nulls for a FOLLOW, and returns the next cursor', async () => {
      tx.notification.findMany.mockResolvedValue([
        notificationRow(),
        notificationRow({ id: POST_ID, type: NotificationType.FOLLOW, post: null, comment: null }),
        notificationRow({ id: COMMENT_ID }),
      ]);

      const page = await service.list(RECIPIENT_ID, pageQuery(2));

      expect(page.items).toEqual([
        {
          id: NOTIFICATION_ID,
          type: NotificationType.COMMENT,
          isRead: false,
          createdAt: CREATED_AT,
          actor: ACTOR,
          post: { id: POST_ID, mediaUrl: 'https://example.com/m.png', mediaType: MediaType.IMAGE },
          comment: { id: COMMENT_ID, body: 'Nice' },
        },
        expect.objectContaining({ id: POST_ID, post: null, comment: null }),
      ]);
      expect(decodeCursor(page.nextCursor ?? undefined)).toEqual({
        createdAt: CREATED_AT,
        id: POST_ID,
      });
    });

    it('rejects an invalid cursor with 400 without querying', async () => {
      await expect(service.list(RECIPIENT_ID, pageQuery(15, 'bad'))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tx.notification.findMany).not.toHaveBeenCalled();
    });
  });

  it("countUnread counts only the user's unread notifications", async () => {
    tx.notification.count.mockResolvedValue(3);

    await expect(service.countUnread(RECIPIENT_ID)).resolves.toEqual({ count: 3 });
    expect(tx.notification.count).toHaveBeenCalledWith({
      where: { recipientId: RECIPIENT_ID, isRead: false },
    });
  });

  describe('markRead', () => {
    it('marks the notification read, scoped to the recipient in the same statement', async () => {
      tx.notification.updateMany.mockResolvedValue({ count: 1 });

      await service.markRead(RECIPIENT_ID, NOTIFICATION_ID);

      expect(tx.notification.updateMany).toHaveBeenCalledWith({
        where: { id: NOTIFICATION_ID, recipientId: RECIPIENT_ID },
        data: { isRead: true },
      });
    });

    it("throws 404 for a missing or someone else's notification", async () => {
      tx.notification.updateMany.mockResolvedValue({ count: 0 });

      const promise = service.markRead(ACTOR_ID, NOTIFICATION_ID);

      await expect(promise).rejects.toBeInstanceOf(NotFoundException);
      await expect(promise).rejects.toThrow(NOTIFICATION_NOT_FOUND);
    });
  });

  it("markAllRead marks only the user's unread notifications", async () => {
    tx.notification.updateMany.mockResolvedValue({ count: 2 });

    await service.markAllRead(RECIPIENT_ID);

    expect(tx.notification.updateMany).toHaveBeenCalledWith({
      where: { recipientId: RECIPIENT_ID, isRead: false },
      data: { isRead: true },
    });
  });

  describe('remove', () => {
    it("removeLike deletes only the actor's LIKE notification for the post", async () => {
      tx.notification.deleteMany.mockResolvedValue({ count: 1 });

      await service.removeLike(client, ACTOR_ID, POST_ID);

      expect(tx.notification.deleteMany).toHaveBeenCalledWith({
        where: { type: NotificationType.LIKE, actorId: ACTOR_ID, postId: POST_ID },
      });
    });

    it("removeFollow deletes only the actor's FOLLOW notification for the user", async () => {
      tx.notification.deleteMany.mockResolvedValue({ count: 1 });

      await service.removeFollow(client, ACTOR_ID, RECIPIENT_ID);

      expect(tx.notification.deleteMany).toHaveBeenCalledWith({
        where: { type: NotificationType.FOLLOW, actorId: ACTOR_ID, recipientId: RECIPIENT_ID },
      });
    });
  });
});
