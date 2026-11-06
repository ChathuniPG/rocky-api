import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { decodeCursor, encodeCursor } from '../../common/pagination/cursor-pagination';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { USER_NOT_FOUND } from '../users/users.constants';
import type { ConversationRow } from './conversation-query';
import { ConversationsService } from './conversations.service';
import { CANNOT_MESSAGE_SELF } from './messages.constants';

// LOW_ID < HIGH_ID as strings and as PostgreSQL uuids.
const LOW_ID = '1c7f7b63-2d2f-4d54-8b30-2e2c303d4e5f';
const HIGH_ID = '7a2d2c2f-9e6b-4b5f-8a62-3c4d5e6f7081';
const CONVERSATION_ID = '3e919d85-4f41-4f76-8d52-404e525f6071';
const OTHER_CONVERSATION_ID = '2d808c74-3e30-4e65-9c41-3f3d414e5f60';
const MESSAGE_ID = '6f1c1b1e-8d5a-4a4e-9a51-2b3c4d5e6f70';
const LAST_MESSAGE_AT = new Date('2026-11-07T10:00:00.123Z');

function conversationRow(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: CONVERSATION_ID,
    lastMessageAt: LAST_MESSAGE_AT,
    otherUserId: HIGH_ID,
    otherUsername: 'bob',
    otherDisplayName: 'Bob',
    otherAvatarUrl: null,
    lastMessageId: MESSAGE_ID,
    lastMessageBody: 'Hi',
    lastMessageSenderId: HIGH_ID,
    lastMessageCreatedAt: LAST_MESSAGE_AT,
    unreadCount: 2,
    ...overrides,
  };
}

const EMPTY_CONVERSATION: Partial<ConversationRow> = {
  lastMessageId: null,
  lastMessageBody: null,
  lastMessageSenderId: null,
  lastMessageCreatedAt: null,
  unreadCount: 0,
};

function pageQuery(limit: number, cursor?: string): PaginationQueryDto {
  const query = new PaginationQueryDto();
  query.limit = limit;
  query.cursor = cursor;
  return query;
}

describe('ConversationsService', () => {
  const prisma = {
    user: { findUnique: jest.fn<Promise<{ id: string } | null>, [unknown]>() },
    conversation: { createMany: jest.fn<Promise<{ count: number }>, [unknown]>() },
    $queryRaw: jest.fn<Promise<ConversationRow[]>, [Prisma.Sql]>(),
  };
  let service: ConversationsService;

  /** The SQL of the n-th $queryRaw call. */
  function sqlOfCall(index = 0): Prisma.Sql {
    const call = prisma.$queryRaw.mock.calls[index];
    if (!call) {
      throw new Error(`$queryRaw was not called ${index + 1} time(s)`);
    }
    return call[0];
  }

  beforeEach(async () => {
    jest.resetAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    prisma.user.findUnique.mockResolvedValue({ id: HIGH_ID });
    prisma.conversation.createMany.mockResolvedValue({ count: 1 });
    prisma.$queryRaw.mockResolvedValue([conversationRow(EMPTY_CONVERSATION)]);

    const moduleRef = await Test.createTestingModule({
      providers: [ConversationsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(ConversationsService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('open', () => {
    it('rejects messaging yourself with 400 before any query', async () => {
      const promise = service.open(LOW_ID, LOW_ID.toUpperCase());

      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      await expect(promise).rejects.toThrow(CANNOT_MESSAGE_SELF);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('throws 404 for an unknown recipient without creating anything', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const promise = service.open(LOW_ID, HIGH_ID);

      await expect(promise).rejects.toBeInstanceOf(NotFoundException);
      await expect(promise).rejects.toThrow(USER_NOT_FOUND);
      expect(prisma.conversation.createMany).not.toHaveBeenCalled();
    });

    it.each([
      ['the caller has the smaller ID', LOW_ID, HIGH_ID],
      ['the caller has the larger ID', HIGH_ID, LOW_ID],
    ])('stores the ordered pair when %s', async (_name, userId, recipientId) => {
      await service.open(userId, recipientId);

      expect(prisma.conversation.createMany).toHaveBeenCalledWith({
        data: [
          {
            userAId: LOW_ID,
            userBId: HIGH_ID,
            createdAt: expect.any(Date),
            lastMessageAt: expect.any(Date),
          },
        ],
        skipDuplicates: true,
      });
      expect(sqlOfCall().values).toEqual(expect.arrayContaining([LOW_ID, HIGH_ID, 1]));
    });

    it('sets last_message_at to the creation time, so new conversations sort first', async () => {
      const now = new Date('2026-11-07T12:00:00.456Z');
      jest.useFakeTimers({ now });
      try {
        await service.open(LOW_ID, HIGH_ID);
      } finally {
        jest.useRealTimers();
      }

      expect(prisma.conversation.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [expect.objectContaining({ createdAt: now, lastMessageAt: now })],
        }),
      );
    });

    it('reports a new conversation as created, with no last message', async () => {
      const result = await service.open(LOW_ID, HIGH_ID);

      expect(result.created).toBe(true);
      expect(result.conversation).toEqual({
        id: CONVERSATION_ID,
        otherUser: { id: HIGH_ID, username: 'bob', displayName: 'Bob', avatarUrl: null },
        lastMessage: null,
        unreadCount: 0,
        lastMessageAt: LAST_MESSAGE_AT,
      });
    });

    it('returns an existing conversation as not created (insert skipped)', async () => {
      prisma.conversation.createMany.mockResolvedValue({ count: 0 });

      const result = await service.open(LOW_ID, HIGH_ID);

      expect(result.created).toBe(false);
      expect(result.conversation.id).toBe(CONVERSATION_ID);
    });

    it('throws 404 if the recipient was deleted before the conversation was read', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await expect(service.open(LOW_ID, HIGH_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('list', () => {
    it("queries the caller's conversations with one extra row and no cursor condition", async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const page = await service.list(LOW_ID, pageQuery(15));

      expect(page).toEqual({ items: [], nextCursor: null });
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const sql = sqlOfCall();
      expect(sql.values).toEqual([LOW_ID, LOW_ID, LOW_ID, LOW_ID, 16]);
      expect(sql.sql).toContain('LEFT JOIN LATERAL');
      expect(sql.sql).toContain('ORDER BY c.last_message_at DESC, c.id DESC');
    });

    it('applies the keyset condition of the cursor', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      const cursor = encodeCursor({ createdAt: LAST_MESSAGE_AT, id: CONVERSATION_ID });

      await service.list(LOW_ID, pageQuery(2, cursor));

      const sql = sqlOfCall();
      expect(sql.sql).toContain('(c.last_message_at, c.id) <');
      expect(sql.values).toEqual([
        LOW_ID,
        LOW_ID,
        LOW_ID,
        LOW_ID,
        LAST_MESSAGE_AT,
        CONVERSATION_ID,
        3,
      ]);
    });

    it('maps rows and points the next cursor at last_message_at of the last item', async () => {
      prisma.$queryRaw.mockResolvedValue([
        conversationRow(),
        conversationRow({ id: OTHER_CONVERSATION_ID, ...EMPTY_CONVERSATION }),
        conversationRow({ id: MESSAGE_ID }),
      ]);

      const page = await service.list(LOW_ID, pageQuery(2));

      expect(page.items).toEqual([
        expect.objectContaining({
          id: CONVERSATION_ID,
          lastMessage: {
            id: MESSAGE_ID,
            body: 'Hi',
            senderId: HIGH_ID,
            createdAt: LAST_MESSAGE_AT,
          },
          unreadCount: 2,
        }),
        expect.objectContaining({ id: OTHER_CONVERSATION_ID, lastMessage: null }),
      ]);
      expect(decodeCursor(page.nextCursor ?? undefined)).toEqual({
        createdAt: LAST_MESSAGE_AT,
        id: OTHER_CONVERSATION_ID,
      });
    });

    it('rejects an invalid cursor with 400 without querying', async () => {
      await expect(service.list(LOW_ID, pageQuery(15, 'bad'))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });
});
