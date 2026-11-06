import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { decodeCursor, encodeCursor } from '../../common/pagination/cursor-pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateMessageDto } from './dto/create-message.dto';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto';
import type { MessageRow } from './message-query';
import { CONVERSATION_NOT_FOUND, CURSOR_WITH_AFTER, INVALID_AFTER } from './messages.constants';
import { MessagesService } from './messages.service';

const USER_ID = '1c7f7b63-2d2f-4d54-8b30-2e2c303d4e5f';
const OTHER_ID = '7a2d2c2f-9e6b-4b5f-8a62-3c4d5e6f7081';
const CONVERSATION_ID = '3e919d85-4f41-4f76-8d52-404e525f6071';
const MESSAGE_ID = '6f1c1b1e-8d5a-4a4e-9a51-2b3c4d5e6f70';
const OTHER_MESSAGE_ID = '2d808c74-3e30-4e65-9c41-3f3d414e5f60';
const CREATED_AT = new Date('2026-11-07T10:00:00.123Z');

const PARTICIPANT_WHERE = {
  where: { id: CONVERSATION_ID, OR: [{ userAId: USER_ID }, { userBId: USER_ID }] },
  select: { id: true },
};

function messageRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    senderId: OTHER_ID,
    body: 'Hi',
    readAt: null,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function listQuery(options: { limit?: number; cursor?: string; after?: string } = {}) {
  const query = new ListMessagesQueryDto();
  query.limit = options.limit ?? 15;
  query.cursor = options.cursor;
  query.after = options.after;
  return query;
}

function body(text: string): CreateMessageDto {
  const dto = new CreateMessageDto();
  dto.body = text;
  return dto;
}

describe('MessagesService', () => {
  const prisma = {
    conversation: {
      findFirst: jest.fn<Promise<{ id: string } | null>, [unknown]>(),
      updateMany: jest.fn<Promise<{ count: number }>, [unknown]>(),
    },
    message: {
      findFirst: jest.fn<Promise<{ id: string; createdAt: Date } | null>, [unknown]>(),
      findMany: jest.fn<Promise<MessageRow[]>, [unknown]>(),
      create: jest.fn<Promise<MessageRow>, [unknown]>(),
      updateMany: jest.fn<Promise<{ count: number }>, [unknown]>(),
    },
    $transaction: jest.fn<Promise<unknown>, [(tx: unknown) => Promise<unknown>]>(),
  };
  let service: MessagesService;

  beforeEach(async () => {
    jest.resetAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    prisma.conversation.findFirst.mockResolvedValue({ id: CONVERSATION_ID });
    prisma.message.findMany.mockResolvedValue([]);
    // The callback receives the same mock as its transaction client.
    prisma.$transaction.mockImplementation((callback) => callback(prisma));

    const moduleRef = await Test.createTestingModule({
      providers: [MessagesService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(MessagesService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('list (history)', () => {
    it('checks participation, then reads newest first with one extra row', async () => {
      const page = await service.list(USER_ID, CONVERSATION_ID, listQuery());

      expect(page).toEqual({ items: [], nextCursor: null });
      expect(prisma.conversation.findFirst).toHaveBeenCalledWith(PARTICIPANT_WHERE);
      expect(prisma.message.findMany).toHaveBeenCalledWith({
        where: { conversationId: CONVERSATION_ID },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 16,
        select: expect.objectContaining({ body: true, readAt: true }),
      });
    });

    it('applies the keyset condition of the cursor and returns the next cursor', async () => {
      prisma.message.findMany.mockResolvedValue([
        messageRow(),
        messageRow({ id: OTHER_MESSAGE_ID }),
      ]);
      const cursor = encodeCursor({ createdAt: CREATED_AT, id: OTHER_MESSAGE_ID });

      const page = await service.list(USER_ID, CONVERSATION_ID, listQuery({ limit: 1, cursor }));

      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            conversationId: CONVERSATION_ID,
            OR: [
              { createdAt: { lt: CREATED_AT } },
              { createdAt: CREATED_AT, id: { lt: OTHER_MESSAGE_ID } },
            ],
          },
        }),
      );
      expect(page.items).toEqual([
        {
          id: MESSAGE_ID,
          conversationId: CONVERSATION_ID,
          senderId: OTHER_ID,
          body: 'Hi',
          readAt: null,
          createdAt: CREATED_AT,
        },
      ]);
      expect(decodeCursor(page.nextCursor ?? undefined)).toEqual({
        createdAt: CREATED_AT,
        id: MESSAGE_ID,
      });
    });

    it("throws 404 for a missing or someone else's conversation without reading messages", async () => {
      prisma.conversation.findFirst.mockResolvedValue(null);

      const promise = service.list(USER_ID, CONVERSATION_ID, listQuery());

      await expect(promise).rejects.toBeInstanceOf(NotFoundException);
      await expect(promise).rejects.toThrow(CONVERSATION_NOT_FOUND);
      expect(prisma.message.findMany).not.toHaveBeenCalled();
    });

    it('rejects an invalid cursor with 400 without querying', async () => {
      await expect(
        service.list(USER_ID, CONVERSATION_ID, listQuery({ cursor: 'bad' })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('list (polling with after)', () => {
    it('returns messages newer than `after`, oldest first, without a cursor', async () => {
      prisma.message.findFirst.mockResolvedValue({ id: MESSAGE_ID, createdAt: CREATED_AT });
      prisma.message.findMany.mockResolvedValue([messageRow({ id: OTHER_MESSAGE_ID })]);

      const page = await service.list(
        USER_ID,
        CONVERSATION_ID,
        listQuery({ limit: 5, after: MESSAGE_ID }),
      );

      expect(prisma.message.findFirst).toHaveBeenCalledWith({
        where: { id: MESSAGE_ID, conversationId: CONVERSATION_ID },
        select: { id: true, createdAt: true },
      });
      expect(prisma.message.findMany).toHaveBeenCalledWith({
        where: {
          conversationId: CONVERSATION_ID,
          OR: [
            { createdAt: { gt: CREATED_AT } },
            { createdAt: CREATED_AT, id: { gt: MESSAGE_ID } },
          ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 5,
        select: expect.any(Object),
      });
      expect(page.nextCursor).toBeNull();
      expect(page.items.map((item) => item.id)).toEqual([OTHER_MESSAGE_ID]);
    });

    it('rejects an `after` that is not a message of this conversation with 400', async () => {
      prisma.message.findFirst.mockResolvedValue(null);

      const promise = service.list(USER_ID, CONVERSATION_ID, listQuery({ after: MESSAGE_ID }));

      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      await expect(promise).rejects.toThrow(INVALID_AFTER);
      expect(prisma.message.findMany).not.toHaveBeenCalled();
    });

    it('rejects cursor and after together with 400 before any query', async () => {
      const cursor = encodeCursor({ createdAt: CREATED_AT, id: MESSAGE_ID });

      const promise = service.list(
        USER_ID,
        CONVERSATION_ID,
        listQuery({ cursor, after: MESSAGE_ID }),
      );

      await expect(promise).rejects.toThrow(CURSOR_WITH_AFTER);
      expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
    });

    it('checks participation before looking up `after`', async () => {
      prisma.conversation.findFirst.mockResolvedValue(null);

      await expect(
        service.list(USER_ID, CONVERSATION_ID, listQuery({ after: MESSAGE_ID })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.message.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('send', () => {
    it('creates the message and moves last_message_at forward, in one transaction', async () => {
      prisma.message.create.mockResolvedValue(messageRow({ senderId: USER_ID }));

      const message = await service.send(USER_ID, CONVERSATION_ID, body('Hi'));

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.conversation.findFirst).toHaveBeenCalledWith(PARTICIPANT_WHERE);
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: { conversationId: CONVERSATION_ID, senderId: USER_ID, body: 'Hi' },
        select: expect.any(Object),
      });
      expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
        where: { id: CONVERSATION_ID, lastMessageAt: { lt: CREATED_AT } },
        data: { lastMessageAt: CREATED_AT },
      });
      expect(message).toEqual(expect.objectContaining({ id: MESSAGE_ID, senderId: USER_ID }));
    });

    it('throws 404 for a non-participant without creating a message', async () => {
      prisma.conversation.findFirst.mockResolvedValue(null);

      await expect(service.send(USER_ID, CONVERSATION_ID, body('Hi'))).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('markRead', () => {
    it("marks only the other participant's unread messages as read", async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 2 });

      await service.markRead(USER_ID, CONVERSATION_ID);

      expect(prisma.conversation.findFirst).toHaveBeenCalledWith(PARTICIPANT_WHERE);
      expect(prisma.message.updateMany).toHaveBeenCalledWith({
        where: { conversationId: CONVERSATION_ID, senderId: { not: USER_ID }, readAt: null },
        data: { readAt: expect.any(Date) },
      });
    });

    it('throws 404 for a non-participant without updating anything', async () => {
      prisma.conversation.findFirst.mockResolvedValue(null);

      await expect(service.markRead(USER_ID, CONVERSATION_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.message.updateMany).not.toHaveBeenCalled();
    });
  });
});
