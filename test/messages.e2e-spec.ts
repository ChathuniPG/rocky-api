import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { cookieHeader } from './helpers/cookies';
import {
  deleteTestUser,
  type SignedUpTestUser,
  signUpTestUser,
  uniqueTestUserCredentials,
} from './helpers/test-user';

// Live test of conversations and messages against the real local database and the real
// Firebase project from .env (Auth only). Prerequisites: `npm run db:up` and migrations
// applied.
//
// Three uniquely named users: A and B talk to each other; C is an outsider who must not
// be able to see or touch their conversation. afterAll always deletes all three users;
// conversations and messages cascade.
//
// The tests build on each other and run in file order. They send well under the
// 30-per-minute message limit.

jest.setTimeout(60_000);

const credentialsA = uniqueTestUserCredentials('msg-a');
const credentialsB = uniqueTestUserCredentials('msg-b');
const credentialsC = uniqueTestUserCredentials('msg-c');

type HttpMethod = 'get' | 'post' | 'patch';

/** The fields of a conversation list item the tests inspect. */
interface ConversationItem {
  id: string;
  otherUserId: string;
  lastMessageId: string | null;
  lastMessageBody: string | null;
  unreadCount: number;
  lastMessageAt: string;
}

/** The fields of a message the tests inspect. */
interface MessageItem {
  id: string;
  senderId: string;
  body: string;
  readAt: string | null;
}

/** A page as returned by any list endpoint. */
interface Page {
  items: unknown[];
  nextCursor: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Reads a string field of a JSON value, failing the test if it is missing. */
function readString(body: unknown, key: string): string {
  const value = isRecord(body) ? body[key] : undefined;
  if (typeof value !== 'string') {
    throw new Error(`Response body has no string "${key}"`);
  }
  return value;
}

function readNullableString(body: unknown, key: string): string | null {
  return isRecord(body) && body[key] === null ? null : readString(body, key);
}

function toPage(body: unknown): Page {
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new Error('Response body is not a page');
  }
  const { nextCursor } = body;
  if (nextCursor !== null && typeof nextCursor !== 'string') {
    throw new Error('Page has an invalid nextCursor');
  }
  return { items: body.items, nextCursor };
}

function toConversationItem(value: unknown): ConversationItem {
  if (!isRecord(value) || typeof value.unreadCount !== 'number') {
    throw new Error('Item is not a conversation');
  }
  const lastMessage = value.lastMessage;
  return {
    id: readString(value, 'id'),
    otherUserId: readString(value.otherUser, 'id'),
    lastMessageId: lastMessage === null ? null : readString(lastMessage, 'id'),
    lastMessageBody: lastMessage === null ? null : readString(lastMessage, 'body'),
    unreadCount: value.unreadCount,
    lastMessageAt: readString(value, 'lastMessageAt'),
  };
}

function toMessageItem(value: unknown): MessageItem {
  return {
    id: readString(value, 'id'),
    senderId: readString(value, 'senderId'),
    body: readString(value, 'body'),
    readAt: readNullableString(value, 'readAt'),
  };
}

describe('Conversations and messages (e2e, live Firebase)', () => {
  let app: NestExpressApplication;
  let userA: SignedUpTestUser;
  let userB: SignedUpTestUser;
  let userC: SignedUpTestUser;
  let conversationAB: string;
  /** IDs of the messages A sent to B, in sending order. */
  const sent: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    userA = await signUpTestUser(app, credentialsA);
    userB = await signUpTestUser(app, credentialsB);
    userC = await signUpTestUser(app, credentialsC);
  });

  afterAll(async () => {
    // Deleting the users from PostgreSQL cascades to their conversations and messages.
    await deleteTestUser(app, credentialsA.email);
    await deleteTestUser(app, credentialsB.email);
    await deleteTestUser(app, credentialsC.email);
    await app?.close();
  });

  function api(method: HttpMethod, path: string, user: SignedUpTestUser | undefined): request.Test {
    const client = request(app.getHttpServer());
    return client[method](`/api/v1${path}`).set(
      'Cookie',
      cookieHeader({ rocky_id: user?.idToken }),
    );
  }

  async function conversations(user: SignedUpTestUser): Promise<ConversationItem[]> {
    const response = await api('get', '/conversations?limit=50', user).expect(200);
    const page = toPage(response.body);
    expect(page.nextCursor).toBeNull();
    return page.items.map(toConversationItem);
  }

  async function unreadConversations(user: SignedUpTestUser): Promise<unknown> {
    const response = await api('get', '/conversations/unread-count', user).expect(200);
    return response.body;
  }

  async function send(user: SignedUpTestUser, conversationId: string, body: string) {
    const response = await api('post', `/conversations/${conversationId}/messages`, user)
      .send({ body })
      .expect(201);
    return toMessageItem(response.body);
  }

  async function poll(user: SignedUpTestUser, afterId: string): Promise<MessageItem[]> {
    const response = await api(
      'get',
      `/conversations/${conversationAB}/messages?after=${afterId}`,
      user,
    ).expect(200);
    const page = toPage(response.body);
    expect(page.nextCursor).toBeNull();
    return page.items.map(toMessageItem);
  }

  describe('opening a conversation', () => {
    it('creates it once (201), then returns the same conversation (200) to either user', async () => {
      const first = await api('post', '/conversations', userA)
        .send({ recipientId: userB.id })
        .expect(201);
      conversationAB = readString(first.body, 'id');
      expect(first.body).toEqual({
        id: conversationAB,
        otherUser: {
          id: userB.id,
          username: userB.username,
          displayName: 'E2E User',
          avatarUrl: null,
        },
        lastMessage: null,
        unreadCount: 0,
        lastMessageAt: expect.any(String),
      });

      const again = await api('post', '/conversations', userA)
        .send({ recipientId: userB.id })
        .expect(200);
      expect(readString(again.body, 'id')).toBe(conversationAB);

      const fromB = await api('post', '/conversations', userB)
        .send({ recipientId: userA.id.toUpperCase() })
        .expect(200);
      expect(readString(fromB.body, 'id')).toBe(conversationAB);
      expect(readString(isRecord(fromB.body) ? fromB.body.otherUser : null, 'id')).toBe(userA.id);
    });

    it('returns one conversation for concurrent opens of the same pair', async () => {
      const responses = await Promise.all(
        [userA, userC, userA, userC].map((user, index) =>
          api('post', '/conversations', user).send({
            recipientId: index % 2 === 0 ? userC.id : userA.id,
          }),
        ),
      );

      const ids = new Set(responses.map((response) => readString(response.body, 'id')));
      expect(ids.size).toBe(1);
      // Exactly one request created it, whichever won the race.
      const statuses = responses.map((response) => response.status);
      expect(statuses.toSorted((left, right) => left - right)).toEqual([200, 200, 200, 201]);
    });

    it('rejects yourself (400), an unknown user (404) and a malformed ID (400)', async () => {
      const self = await api('post', '/conversations', userA)
        .send({ recipientId: userA.id })
        .expect(400);
      expect(self.body).toMatchObject({
        statusCode: 400,
        message: 'You cannot start a conversation with yourself',
      });
      await api('post', '/conversations', userA).send({ recipientId: randomUUID() }).expect(404);
      await api('post', '/conversations', userA).send({ recipientId: 'nope' }).expect(400);
      await api('post', '/conversations', undefined).send({ recipientId: userB.id }).expect(401);
    });
  });

  describe('sending', () => {
    it("shows A's messages as unread in B's list, with the last one as preview", async () => {
      for (const body of ['one', 'two', '  three  ']) {
        const message = await send(userA, conversationAB, body);
        expect(message).toMatchObject({ senderId: userA.id, readAt: null });
        sent.push(message.id);
      }

      const listB = await conversations(userB);
      expect(listB).toEqual([
        expect.objectContaining({
          id: conversationAB,
          otherUserId: userA.id,
          lastMessageId: sent[2],
          // The body was trimmed before it was stored.
          lastMessageBody: 'three',
          unreadCount: 3,
        }),
      ]);
      // Your own messages never count as unread.
      const forA = (await conversations(userA)).find((item) => item.id === conversationAB);
      expect(forA).toMatchObject({ unreadCount: 0, lastMessageId: sent[2] });
    });

    it('rejects blank and over-long bodies with 400', async () => {
      const path = `/conversations/${conversationAB}/messages`;
      await api('post', path, userA).send({ body: '   ' }).expect(400);
      await api('post', path, userA).send({ body: '' }).expect(400);
      await api('post', path, userA)
        .send({ body: 'a'.repeat(1001) })
        .expect(400);
    });
  });

  describe('polling with after', () => {
    it('returns only messages newer than `after`, oldest first', async () => {
      expect((await poll(userB, sent[0])).map((message) => message.id)).toEqual([sent[1], sent[2]]);
      expect(await poll(userB, sent[2])).toEqual([]);

      const latest = await send(userA, conversationAB, 'four');
      sent.push(latest.id);
      expect(await poll(userB, sent[2])).toEqual([
        expect.objectContaining({ id: latest.id, body: 'four' }),
      ]);
    });

    it('rejects an unknown `after` and `after` combined with `cursor` (400)', async () => {
      const base = `/conversations/${conversationAB}/messages`;
      await api('get', `${base}?after=${randomUUID()}`, userB).expect(400);
      await api('get', `${base}?after=not-a-uuid`, userB).expect(400);

      const firstPage = await api('get', `${base}?limit=1`, userB).expect(200);
      const cursor = toPage(firstPage.body).nextCursor;
      expect(cursor).not.toBeNull();
      await api('get', `${base}?after=${sent[0]}&cursor=${cursor ?? ''}`, userB).expect(400);
    });
  });

  describe('history', () => {
    it('paginates newest first across pages without gaps or duplicates', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = cursor === null ? '' : `&cursor=${cursor}`;
        const response = await api(
          'get',
          `/conversations/${conversationAB}/messages?limit=2${query}`,
          userB,
        ).expect(200);
        const page = toPage(response.body);
        expect(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items.map((item) => readString(item, 'id')));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 10);

      expect(pages).toBe(2);
      expect(seen).toEqual(sent.toReversed());
    });
  });

  describe('marking as read', () => {
    it("sets readAt on the other user's messages and resets the unread count", async () => {
      await api('patch', `/conversations/${conversationAB}/read`, userB).expect(204);
      // Idempotent.
      await api('patch', `/conversations/${conversationAB}/read`, userB).expect(204);

      expect(await conversations(userB)).toEqual([
        expect.objectContaining({ id: conversationAB, unreadCount: 0 }),
      ]);
      const response = await api(
        'get',
        `/conversations/${conversationAB}/messages?limit=50`,
        userA,
      ).expect(200);
      const messages = toPage(response.body).items.map(toMessageItem);
      expect(messages.every((message) => message.readAt !== null)).toBe(true);
    });
  });

  describe('outsiders', () => {
    it("returns 404 when C reads, sends to or marks A and B's conversation", async () => {
      const base = `/conversations/${conversationAB}`;
      const read = await api('get', `${base}/messages`, userC).expect(404);
      expect(read.body).toMatchObject({ statusCode: 404, message: 'Conversation not found' });
      await api('get', `${base}/messages?after=${sent[0]}`, userC).expect(404);
      await api('post', `${base}/messages`, userC).send({ body: 'hi' }).expect(404);
      await api('patch', `${base}/read`, userC).expect(404);

      expect((await conversations(userC)).map((item) => item.id)).not.toContain(conversationAB);
      // C's attempt changed nothing.
      expect(await poll(userB, sent[3])).toEqual([]);
    });

    it('returns 404 for an unknown conversation, 400 for a malformed ID, 401 without auth', async () => {
      await api('get', `/conversations/${randomUUID()}/messages`, userA).expect(404);
      await api('get', '/conversations/not-a-uuid/messages', userA).expect(400);
      await api('get', '/conversations?cursor=bad', userA).expect(400);
      await api('get', '/conversations', undefined).expect(401);
      await api('patch', `/conversations/${conversationAB}/read`, undefined).expect(401);
    });
  });

  describe('ordering', () => {
    it("orders A's conversations by latest activity", async () => {
      const listA = await conversations(userA);
      const conversationAC = listA.find((item) => item.otherUserId === userC.id)?.id;
      if (conversationAC === undefined) {
        throw new Error('A has no conversation with C');
      }

      // A–C (opened in the concurrency test, still empty) is older than A's messages to B.
      expect(listA.map((item) => item.id)).toEqual([conversationAB, conversationAC]);
      expect(listA[1]).toMatchObject({ lastMessageId: null });

      await send(userA, conversationAC, 'hello C');
      const reordered = await conversations(userA);
      expect(reordered.map((item) => item.id)).toEqual([conversationAC, conversationAB]);
      const times = reordered.map((item) => Date.parse(item.lastMessageAt));
      expect(times).toEqual(times.toSorted((left, right) => right - left));
    });

    it('puts a newly opened, empty conversation first', async () => {
      const opened = await api('post', '/conversations', userC)
        .send({ recipientId: userB.id })
        .expect(201);

      expect((await conversations(userB)).map((item) => item.id)).toEqual([
        readString(opened.body, 'id'),
        conversationAB,
      ]);
    });

    it('paginates the conversation list with a cursor', async () => {
      const first = await api('get', '/conversations?limit=1', userA).expect(200);
      const page1 = toPage(first.body);
      expect(page1.items).toHaveLength(1);
      expect(page1.nextCursor).not.toBeNull();

      const second = await api(
        'get',
        `/conversations?limit=1&cursor=${page1.nextCursor ?? ''}`,
        userA,
      ).expect(200);
      const page2 = toPage(second.body);
      expect(page2.items).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();
      expect(readString(page2.items[0], 'id')).not.toBe(readString(page1.items[0], 'id'));
    });
  });

  // State on entry: A–B fully read by B, C–B empty, A–C holds A's unread "hello C".
  describe('unread conversations count', () => {
    let conversationCB: string;

    it('is zero when every conversation is read or empty', async () => {
      expect(await unreadConversations(userB)).toEqual({ count: 0 });
      // A's only unread-for-someone message is A's own, which never counts for A.
      expect(await unreadConversations(userA)).toEqual({ count: 0 });
    });

    it('counts several unread messages in one conversation once', async () => {
      await send(userA, conversationAB, 'five');
      await send(userA, conversationAB, 'six');

      expect(await unreadConversations(userB)).toEqual({ count: 1 });
      expect(await unreadConversations(userA)).toEqual({ count: 0 });
    });

    it('counts unread messages in two conversations as 2', async () => {
      const opened = await api('post', '/conversations', userC)
        .send({ recipientId: userB.id })
        .expect(200);
      conversationCB = readString(opened.body, 'id');
      await send(userC, conversationCB, 'hi B');

      expect(await unreadConversations(userB)).toEqual({ count: 2 });
    });

    it('decreases when a conversation is marked read', async () => {
      await api('patch', `/conversations/${conversationAB}/read`, userB).expect(204);

      expect(await unreadConversations(userB)).toEqual({ count: 1 });
    });

    it("never counts another user's conversations", async () => {
      // C has unread only in A–C; B's unread C–B message is C's own, and A–B is not C's.
      expect(await unreadConversations(userC)).toEqual({ count: 1 });
      await api('patch', `/conversations/${conversationCB}/read`, userB).expect(204);
      expect(await unreadConversations(userB)).toEqual({ count: 0 });
      expect(await unreadConversations(userC)).toEqual({ count: 1 });
    });

    it('requires authentication (401)', async () => {
      await api('get', '/conversations/unread-count', undefined).expect(401);
    });
  });
});
