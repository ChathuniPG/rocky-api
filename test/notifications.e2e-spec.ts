import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { FirebaseStorageService } from '../src/firebase/firebase-storage.service';
import { TINY_PNG } from './fixtures/media.fixture';
import { cookieHeader } from './helpers/cookies';
import {
  deleteTestUser,
  type SignedUpTestUser,
  signUpTestUser,
  uniqueTestUserCredentials,
} from './helpers/test-user';

// Live test of notifications against the real local database and the real Firebase
// project from .env (Auth and Storage). Prerequisites: `npm run db:up`, migrations
// applied, and a configured Firebase project with email/password sign-in and a bucket.
//
// Two uniquely named users, each with one post: B likes, comments on and follows A.
// afterAll always deletes both uploaded objects and both users; posts, likes, comments,
// follows and notifications cascade.
//
// The tests build on each other and run in file order.

jest.setTimeout(60_000);

const credentialsA = uniqueTestUserCredentials('notif-a');
const credentialsB = uniqueTestUserCredentials('notif-b');

type HttpMethod = 'get' | 'post' | 'patch' | 'delete';

/** The fields of a notification item the tests inspect. */
interface NotificationItem {
  id: string;
  type: string;
  isRead: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Reads a string field of a JSON response body, failing the test if it is missing. */
function readString(body: unknown, key: string): string {
  const value = isRecord(body) ? body[key] : undefined;
  if (typeof value !== 'string') {
    throw new Error(`Response body has no string "${key}"`);
  }
  return value;
}

function ofType(items: NotificationItem[], type: string): NotificationItem[] {
  return items.filter((item) => item.type === type);
}

function toNotificationItem(value: unknown): NotificationItem {
  if (!isRecord(value) || typeof value.isRead !== 'boolean') {
    throw new Error('Item is not a notification');
  }
  return { id: readString(value, 'id'), type: readString(value, 'type'), isRead: value.isRead };
}

describe('Notifications (e2e, live Firebase)', () => {
  let app: NestExpressApplication;
  let userA: SignedUpTestUser;
  let userB: SignedUpTestUser;
  const mediaPaths: string[] = [];
  let postA: { id: string; mediaUrl: string };
  let postB: { id: string };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    userA = await signUpTestUser(app, credentialsA);
    userB = await signUpTestUser(app, credentialsB);

    const createdA = await createPost(userA);
    postA = { id: readString(createdA, 'id'), mediaUrl: readString(createdA, 'mediaUrl') };
    postB = { id: readString(await createPost(userB), 'id') };
  });

  afterAll(async () => {
    if (app) {
      const storage = app.get(FirebaseStorageService);
      for (const mediaPath of mediaPaths) {
        await storage.deleteObject(mediaPath);
      }
    }
    // Deleting the users from PostgreSQL cascades to everything they created.
    await deleteTestUser(app, credentialsA.email);
    await deleteTestUser(app, credentialsB.email);
    await app?.close();
  });

  function api(method: HttpMethod, path: string, user: SignedUpTestUser | undefined): request.Test {
    const client = request(app.getHttpServer());
    return client[method](`/api/v1${path}`).set(
      'Cookie',
      cookieHeader({ rocky_id: user?.idToken }),
    );
  }

  /** Uploads a tiny image and creates a post from it; returns the post body. */
  async function createPost(user: SignedUpTestUser): Promise<unknown> {
    const upload = await api('post', '/uploads', user)
      .field('purpose', 'post')
      .attach('file', TINY_PNG, { filename: 'pixel.png', contentType: 'image/png' })
      .expect(201);
    const mediaPath = readString(upload.body, 'path');
    mediaPaths.push(mediaPath);
    const post = await api('post', '/posts', user).send({ mediaPath }).expect(201);
    return post.body;
  }

  /** The raw items of the user's first (and, in these tests, only) page. */
  async function listRaw(user: SignedUpTestUser): Promise<unknown[]> {
    const response = await api('get', '/notifications?limit=50', user).expect(200);
    const body: unknown = response.body;
    if (!isRecord(body) || !Array.isArray(body.items)) {
      throw new Error('Response body is not a page');
    }
    expect(body.nextCursor).toBeNull();
    return body.items;
  }

  async function list(user: SignedUpTestUser): Promise<NotificationItem[]> {
    return (await listRaw(user)).map(toNotificationItem);
  }

  async function unreadCount(user: SignedUpTestUser): Promise<unknown> {
    const response = await api('get', '/notifications/unread-count', user).expect(200);
    return response.body;
  }

  describe('creating', () => {
    let commentId: string;

    it('gives A three unread notifications when B likes, comments on and follows A', async () => {
      await api('post', `/posts/${postA.id}/like`, userB).expect(200);
      const comment = await api('post', `/posts/${postA.id}/comments`, userB)
        .send({ body: 'Nice post' })
        .expect(201);
      commentId = readString(comment.body, 'id');
      await api('post', `/users/${userA.id}/follow`, userB).expect(200);

      const items = await listRaw(userA);
      const actor = {
        id: userB.id,
        username: userB.username,
        displayName: 'E2E User',
        avatarUrl: null,
      };
      const post = { id: postA.id, mediaUrl: postA.mediaUrl, mediaType: 'IMAGE' };
      const common = {
        id: expect.any(String),
        isRead: false,
        createdAt: expect.any(String),
        actor,
      };
      expect(items).toHaveLength(3);
      expect(items).toEqual(
        expect.arrayContaining([
          { ...common, type: 'LIKE', post, comment: null },
          { ...common, type: 'COMMENT', post, comment: { id: commentId, body: 'Nice post' } },
          { ...common, type: 'FOLLOW', post: null, comment: null },
        ]),
      );
      expect(await unreadCount(userA)).toEqual({ count: 3 });
      expect(await list(userB)).toEqual([]);
    });

    it("lists A's notifications newest first", async () => {
      const response = await api('get', '/notifications?limit=50', userA).expect(200);
      const body: unknown = response.body;
      const items = isRecord(body) && Array.isArray(body.items) ? body.items : [];
      const times = items.map((item) => Date.parse(readString(item, 'createdAt')));
      expect(times).toEqual(times.toSorted((left, right) => right - left));
    });

    it("creates nothing for B's own actions on B's own post", async () => {
      await api('post', `/posts/${postB.id}/like`, userB).expect(200);
      await api('post', `/posts/${postB.id}/comments`, userB).send({ body: 'Mine' }).expect(201);

      expect(await list(userB)).toEqual([]);
      expect(await unreadCount(userB)).toEqual({ count: 0 });
      expect(await list(userA)).toHaveLength(3);
    });
  });

  describe('toggling', () => {
    it('removes the matching notifications on unlike and unfollow', async () => {
      await api('delete', `/posts/${postA.id}/like`, userB).expect(200);
      await api('delete', `/users/${userA.id}/follow`, userB).expect(200);

      const items = await list(userA);
      expect(items.map((item) => item.type)).toEqual(['COMMENT']);
      expect(await unreadCount(userA)).toEqual({ count: 1 });
    });

    it('leaves exactly one LIKE after like → unlike → like', async () => {
      await api('post', `/posts/${postA.id}/like`, userB).expect(200);
      await api('delete', `/posts/${postA.id}/like`, userB).expect(200);
      await api('post', `/posts/${postA.id}/like`, userB).expect(200);
      // A repeated like inserts no row, so it must not notify again either.
      await api('post', `/posts/${postA.id}/like`, userB).expect(200);

      const items = await list(userA);
      expect(ofType(items, 'LIKE')).toHaveLength(1);
      expect(items).toHaveLength(2);
    });
  });

  describe('marking as read', () => {
    it("returns 404 when B marks A's notification, leaving it unread", async () => {
      const [target] = await list(userA);
      const response = await api('patch', `/notifications/${target.id}/read`, userB).expect(404);
      expect(response.body).toMatchObject({ statusCode: 404, message: 'Notification not found' });

      expect(await unreadCount(userA)).toEqual({ count: 2 });
    });

    it('decrements the unread count when A marks one read, idempotently', async () => {
      const [target] = await list(userA);
      await api('patch', `/notifications/${target.id}/read`, userA).expect(204);
      await api('patch', `/notifications/${target.id}/read`, userA).expect(204);

      expect(await unreadCount(userA)).toEqual({ count: 1 });
      const items = await list(userA);
      expect(items.find((item) => item.id === target.id)).toMatchObject({ isRead: true });
    });

    it('marks everything read with read-all', async () => {
      await api('patch', '/notifications/read-all', userA).expect(204);

      expect(await unreadCount(userA)).toEqual({ count: 0 });
      expect((await list(userA)).every((item) => item.isRead)).toBe(true);
    });

    it('rejects malformed IDs (400), unknown IDs (404) and missing auth (401)', async () => {
      await api('patch', '/notifications/not-a-uuid/read', userA).expect(400);
      await api('patch', `/notifications/${randomUUID()}/read`, userA).expect(404);
      await api('get', '/notifications?cursor=bad', userA).expect(400);
      await api('get', '/notifications', undefined).expect(401);
      await api('get', '/notifications/unread-count', undefined).expect(401);
      await api('patch', '/notifications/read-all', undefined).expect(401);
    });
  });

  describe('notifications turned off (FR-SET-02)', () => {
    it('creates nothing new for A while A has notificationsEnabled false', async () => {
      await api('patch', '/users/me', userA).send({ notificationsEnabled: false }).expect(200);
      const before = (await list(userA)).map((item) => item.id);

      await api('delete', `/posts/${postA.id}/like`, userB).expect(200);
      await api('post', `/posts/${postA.id}/like`, userB).expect(200);
      await api('post', `/posts/${postA.id}/comments`, userB).send({ body: 'Again' }).expect(201);
      await api('post', `/users/${userA.id}/follow`, userB).expect(200);

      const after = (await list(userA)).map((item) => item.id);
      // The unlike still removed the old LIKE; nothing was added.
      expect(before).toEqual(expect.arrayContaining(after));
      expect(after.length).toBeLessThan(before.length);
      expect(await unreadCount(userA)).toEqual({ count: 0 });
    });
  });
});
