import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Prisma } from '../../generated/prisma/client';
import { NotificationType } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { type NewNotification, NotificationsService } from './notifications.service';

const ACTOR_ID = '6f1c1b1e-8d5a-4a4e-9a51-2b3c4d5e6f70';
const RECIPIENT_ID = '7a2d2c2f-9e6b-4b5f-8a62-3c4d5e6f7081';
const POST_ID = '1c7f7b63-2d2f-4d54-8b30-2e2c303d4e5f';
const COMMENT_ID = '2d808c74-3e30-4e65-9c41-3f3d414e5f60';
const NOTIFICATION_ID = '3e919d85-4f41-4f76-8d52-404e525f6071';

describe('NotificationsService', () => {
  const tx = {
    user: {
      findUnique: jest.fn<Promise<{ notificationsEnabled: boolean } | null>, [unknown]>(),
    },
    notification: {
      create: jest.fn<Promise<{ id: string }>, [unknown]>(),
      deleteMany: jest.fn<Promise<{ count: number }>, [unknown]>(),
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
      // Registered as PrismaService only so the container hands the mock back typed, to
      // be passed in as the transaction client, without an unsafe type assertion.
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
