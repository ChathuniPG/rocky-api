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

// Live test of likes, saves and comments against the real local database and the real
// Firebase project from .env (Auth and Storage). Prerequisites: `npm run db:up`,
// migrations applied, and a configured Firebase project with email/password sign-in and
// a bucket.
//
// Two uniquely named users: A owns the post, B likes, saves and comments on it. afterAll
// always deletes the uploaded object and both users; posts and comments cascade.
//
// The tests build on each other and run in file order.

jest.setTimeout(60_000);

const credentialsA = uniqueTestUserCredentials('engage-a');
const credentialsB = uniqueTestUserCredentials('engage-b');

type HttpMethod = 'get' | 'post' | 'delete';

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

/** Reads the items and next cursor of a page. */
function readPage(body: unknown): { items: unknown[]; ids: string[]; nextCursor: string | null } {
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new Error('Response body is not a page');
  }
  const items: unknown[] = body.items;
  const ids = items.map((item) => readString(item, 'id'));
  const nextCursor = typeof body.nextCursor === 'string' ? body.nextCursor : null;
  return { items, ids, nextCursor };
}

describe('Likes, saves and comments (e2e, live Firebase)', () => {
  let app: NestExpressApplication;
  let userA: SignedUpTestUser;
  let userB: SignedUpTestUser;
  let mediaPath: string | undefined;
  let postId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    userA = await signUpTestUser(app, credentialsA);
    userB = await signUpTestUser(app, credentialsB);

    const upload = await api('post', '/uploads', userA)
      .field('purpose', 'post')
      .attach('file', TINY_PNG, { filename: 'pixel.png', contentType: 'image/png' })
      .expect(201);
    mediaPath = readString(upload.body, 'path');
    const post = await api('post', '/posts', userA).send({ mediaPath }).expect(201);
    postId = readString(post.body, 'id');
  });

  afterAll(async () => {
    if (app && mediaPath) {
      await app.get(FirebaseStorageService).deleteObject(mediaPath);
    }
    // Users first deleted from PostgreSQL: their posts, likes, saves and comments cascade.
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

  async function getPost(user: SignedUpTestUser): Promise<Record<string, unknown>> {
    const response = await api('get', `/posts/${postId}`, user).expect(200);
    const body: unknown = response.body;
    if (!isRecord(body)) {
      throw new Error('Response body is not a post');
    }
    return body;
  }

  describe('likes', () => {
    it('counts B liking twice as one like (200 both times)', async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await api('post', `/posts/${postId}/like`, userB).expect(200);
        expect(response.body).toEqual({ likedByMe: true, likeCount: 1 });
      }
    });

    it("shows likeCount 1 and likedByMe true in B's feed, likedByMe false for A", async () => {
      const feed = await api('get', '/posts/feed?limit=50', userB).expect(200);
      const post = readPage(feed.body).items.find((item) => isRecord(item) && item.id === postId);
      expect(post).toMatchObject({ likeCount: 1, likedByMe: true });

      expect(await getPost(userA)).toMatchObject({ likeCount: 1, likedByMe: false });
    });

    it('takes the count back to 0 when B unlikes twice, never below', async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await api('delete', `/posts/${postId}/like`, userB).expect(200);
        expect(response.body).toEqual({ likedByMe: false, likeCount: 0 });
      }
      expect(await getPost(userB)).toMatchObject({ likeCount: 0, likedByMe: false });
    });
  });

  describe('saves', () => {
    it('reflects save and unsave in savedByMe, idempotently', async () => {
      const saved = await api('post', `/posts/${postId}/save`, userB).expect(200);
      expect(saved.body).toEqual({ savedByMe: true });
      await api('post', `/posts/${postId}/save`, userB).expect(200);
      expect(await getPost(userB)).toMatchObject({ savedByMe: true });
      expect(await getPost(userA)).toMatchObject({ savedByMe: false });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await api('delete', `/posts/${postId}/save`, userB).expect(200);
        expect(response.body).toEqual({ savedByMe: false });
      }
      expect(await getPost(userB)).toMatchObject({ savedByMe: false });
    });
  });

  describe('comments', () => {
    let commentId: string;

    it('lets B comment (201): body trimmed, listed with its author, commentCount 1', async () => {
      const created = await api('post', `/posts/${postId}/comments`, userB)
        .send({ body: '  Nice post  ' })
        .expect(201);

      commentId = readString(created.body, 'id');
      expect(created.body).toEqual({
        id: commentId,
        postId,
        body: 'Nice post',
        createdAt: expect.any(String),
        author: {
          id: userB.id,
          username: userB.username,
          displayName: 'E2E User',
          avatarUrl: null,
        },
      });

      const list = await api('get', `/posts/${postId}/comments`, userA).expect(200);
      expect(list.body).toEqual({ items: [created.body], nextCursor: null });
      expect(await getPost(userA)).toMatchObject({ commentCount: 1 });
    });

    it('rejects blank, too long and unknown-field bodies (400)', async () => {
      const path = `/posts/${postId}/comments`;
      await api('post', path, userB).send({ body: '   ' }).expect(400);
      await api('post', path, userB)
        .send({ body: 'a'.repeat(501) })
        .expect(400);
      await api('post', path, userB).send({ body: 'hi', authorId: userA.id }).expect(400);
      expect(await getPost(userA)).toMatchObject({ commentCount: 1 });
    });

    it("forbids A from deleting B's comment (403)", async () => {
      await api('delete', `/comments/${commentId}`, userA).expect(403);
      expect(await getPost(userA)).toMatchObject({ commentCount: 1 });
    });

    it('lets B delete it: 204, then 404, and commentCount is 0', async () => {
      await api('delete', `/comments/${commentId}`, userB).expect(204);
      await api('delete', `/comments/${commentId}`, userB).expect(404);

      const list = await api('get', `/posts/${postId}/comments`, userA).expect(200);
      expect(list.body).toEqual({ items: [], nextCursor: null });
      expect(await getPost(userA)).toMatchObject({ commentCount: 0 });
    });

    it('pages through comments newest first across two pages, without repeats', async () => {
      for (const body of ['first', 'second', 'third']) {
        await api('post', `/posts/${postId}/comments`, userB).send({ body }).expect(201);
      }
      // The full list gives the expected order, including any same-millisecond ties.
      const all = await api('get', `/posts/${postId}/comments?limit=50`, userB).expect(200);
      const expectedIds = readPage(all.body).ids;
      expect(expectedIds).toHaveLength(3);
      expect(readPage(all.body).items.map((item) => readString(item, 'body'))).toEqual([
        'third',
        'second',
        'first',
      ]);

      const first = await api('get', `/posts/${postId}/comments?limit=2`, userB).expect(200);
      const page1 = readPage(first.body);
      expect(page1.ids).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();

      const cursor = encodeURIComponent(page1.nextCursor ?? '');
      const second = await api(
        'get',
        `/posts/${postId}/comments?limit=2&cursor=${cursor}`,
        userB,
      ).expect(200);
      const page2 = readPage(second.body);
      expect(page2.ids).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();

      expect([...page1.ids, ...page2.ids]).toEqual(expectedIds);
      expect(await getPost(userA)).toMatchObject({ commentCount: 3 });
    });
  });

  describe('validation and missing resources', () => {
    it('rejects malformed IDs (400) and reports unknown ones (404)', async () => {
      await api('post', '/posts/not-a-uuid/like', userB).expect(400);
      await api('delete', '/comments/not-a-uuid', userB).expect(400);
      await api('get', `/posts/${postId}/comments?cursor=bad`, userB).expect(400);

      const missing = randomUUID();
      const like = await api('post', `/posts/${missing}/like`, userB).expect(404);
      expect(like.body).toMatchObject({ statusCode: 404, message: 'Post not found' });
      await api('post', `/posts/${missing}/save`, userB).expect(404);
      await api('get', `/posts/${missing}/comments`, userB).expect(404);
      await api('post', `/posts/${missing}/comments`, userB).send({ body: 'hi' }).expect(404);
      await api('delete', `/comments/${missing}`, userB).expect(404);
    });

    it('rejects unauthenticated requests (401)', async () => {
      await api('post', `/posts/${postId}/like`, undefined).expect(401);
      await api('get', `/posts/${postId}/comments`, undefined).expect(401);
    });

    it('returns 404 "Post not found" when liking or listing comments of a deleted post', async () => {
      await api('delete', `/posts/${postId}`, userA).expect(204);

      const like = await api('post', `/posts/${postId}/like`, userB).expect(404);
      expect(like.body).toMatchObject({ statusCode: 404, message: 'Post not found' });
      await api('delete', `/posts/${postId}/like`, userB).expect(404);
      await api('get', `/posts/${postId}/comments`, userB).expect(404);
    });
  });
});
