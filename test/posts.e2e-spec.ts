import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { FirebaseStorageService } from '../src/firebase/firebase-storage.service';
import { MediaType } from '../src/generated/prisma/enums';
import { PrismaService } from '../src/prisma/prisma.service';
import { TINY_PNG } from './fixtures/media.fixture';
import { cookieHeader } from './helpers/cookies';
import {
  deleteTestUser,
  type SignedUpTestUser,
  signUpTestUser,
  uniqueTestUserCredentials,
} from './helpers/test-user';

// Live test of the posts endpoints against the real local database and the real Firebase
// project from .env (Auth and Storage). Prerequisites: `npm run db:up`, migrations
// applied, and a configured Firebase project with email/password sign-in and a bucket.
//
// Two uniquely named users: A owns the post, B tries to use and modify it. afterAll
// always deletes every uploaded object and both users; their posts cascade.
//
// The tests in the first describe build on each other and run in file order.

jest.setTimeout(60_000);

const credentialsA = uniqueTestUserCredentials('posts-a');
const credentialsB = uniqueTestUserCredentials('posts-b');

type HttpMethod = 'get' | 'post' | 'patch' | 'delete';

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

/** Reads the post IDs and next cursor of a feed page. */
function readPage(body: unknown): { ids: string[]; nextCursor: string | null } {
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new Error('Response body is not a page');
  }
  const ids = body.items.map((item: unknown) => readString(item, 'id'));
  const nextCursor = typeof body.nextCursor === 'string' ? body.nextCursor : null;
  return { ids, nextCursor };
}

describe('Posts (e2e, live Firebase)', () => {
  let app: NestExpressApplication;
  let userA: SignedUpTestUser;
  let userB: SignedUpTestUser;
  const uploadedPaths: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    userA = await signUpTestUser(app, credentialsA);
    userB = await signUpTestUser(app, credentialsB);
  });

  afterAll(async () => {
    if (app) {
      const storage = app.get(FirebaseStorageService);
      await Promise.all(uploadedPaths.map((path) => storage.deleteObject(path)));
    }
    // Users first deleted from PostgreSQL: their posts, likes and saves cascade.
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

  async function uploadPng(user: SignedUpTestUser): Promise<string> {
    const response = await api('post', '/uploads', user)
      .field('purpose', 'post')
      .attach('file', TINY_PNG, { filename: 'pixel.png', contentType: 'image/png' })
      .expect(201);
    const path = readString(response.body, 'path');
    uploadedPaths.push(path);
    return path;
  }

  describe('post lifecycle', () => {
    let mediaPath: string;
    let postId: string;

    it('lets A create a post from their own upload (201)', async () => {
      mediaPath = await uploadPng(userA);

      const response = await api('post', '/posts', userA)
        .send({ caption: '  First post  ', mediaPath })
        .expect(201);

      postId = readString(response.body, 'id');
      expect(response.body).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        caption: 'First post',
        mediaUrl: expect.stringMatching(/^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\//),
        mediaType: MediaType.IMAGE,
        likeCount: 0,
        commentCount: 0,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        author: {
          id: userA.id,
          username: userA.username,
          displayName: 'E2E User',
          avatarUrl: null,
        },
        likedByMe: false,
        savedByMe: false,
      });
      // Internal columns never leak.
      expect(response.body).not.toHaveProperty('mediaPath');
      expect(response.body).not.toHaveProperty('authorId');
    });

    it('shows the post in the feed and by id, for both users', async () => {
      const feed = await api('get', '/posts/feed?limit=50', userB).expect(200);
      expect(readPage(feed.body).ids).toContain(postId);

      const byOwner = await api('get', `/posts/${postId}`, userA).expect(200);
      const byOther = await api('get', `/posts/${postId}`, userB).expect(200);
      expect(byOwner.body).toMatchObject({ id: postId, caption: 'First post' });
      expect(byOther.body).toEqual(byOwner.body);
    });

    it('rejects reusing the same upload (409)', async () => {
      const response = await api('post', '/posts', userA).send({ mediaPath }).expect(409);

      expect(response.body).toMatchObject({ statusCode: 409, error: 'Conflict' });
    });

    it("rejects B creating a post from A's upload (403)", async () => {
      await api('post', '/posts', userB).send({ mediaPath }).expect(403);
    });

    it('rejects a well-formed path with no uploaded object (400)', async () => {
      const missing = `posts/${userA.id}/${randomUUID()}.png`;

      await api('post', '/posts', userA).send({ mediaPath: missing }).expect(400);
    });

    it('rejects a malformed path and client-supplied media fields (400)', async () => {
      await api('post', '/posts', userA)
        .send({ mediaPath: `posts/${userA.id}/../x.png` })
        .expect(400);
      await api('post', '/posts', userA)
        .send({ mediaPath, mediaUrl: 'https://evil.example/x.png' })
        .expect(400);
    });

    it('validates the id (400) and reports a missing post (404)', async () => {
      await api('get', '/posts/not-a-uuid', userA).expect(400);
      await api('get', `/posts/${randomUUID()}`, userA).expect(404);
    });

    it("forbids B from editing or deleting A's post (403)", async () => {
      await api('patch', `/posts/${postId}`, userB).send({ caption: 'hacked' }).expect(403);
      await api('delete', `/posts/${postId}`, userB).expect(403);

      const unchanged = await api('get', `/posts/${postId}`, userA).expect(200);
      expect(unchanged.body).toMatchObject({ caption: 'First post' });
    });

    it('lets A edit the caption, and only the caption', async () => {
      await api('patch', `/posts/${postId}`, userA)
        .send({ caption: 'x', mediaPath: 'posts/other' })
        .expect(400);

      const response = await api('patch', `/posts/${postId}`, userA)
        .send({ caption: '  Edited caption ' })
        .expect(200);

      expect(response.body).toMatchObject({ id: postId, caption: 'Edited caption' });
    });

    it('lets A delete the post: 204, then 404, and the media object is gone', async () => {
      await api('delete', `/posts/${postId}`, userA).expect(204);

      await api('get', `/posts/${postId}`, userA).expect(404);
      await api('delete', `/posts/${postId}`, userA).expect(404);
      const metadata = await app.get(FirebaseStorageService).getObjectMetadata(mediaPath);
      expect(metadata).toEqual({ exists: false });
    });

    it('rejects unauthenticated requests (401)', async () => {
      await api('get', '/posts/feed', undefined).expect(401);
      await api('post', '/posts', undefined).send({ mediaPath }).expect(401);
    });
  });

  describe('feed pagination', () => {
    it('pages through posts newest first, with identical timestamps, no gaps or repeats', async () => {
      // Far-future timestamps put the seeded posts at the top of the shared feed, ahead of
      // any other data in the local database. The random offset keeps runs apart.
      const base = Date.UTC(2100, 0, 1) + Math.floor(Math.random() * 1e9) * 1000;
      const sameTime = new Date(base);
      const later = new Date(base + 1);
      const seeded = await app.get(PrismaService).post.createManyAndReturn({
        data: [later, sameTime, sameTime, sameTime, sameTime].map((createdAt) => ({
          authorId: userA.id,
          // Rows only: these media paths have no Storage object and are never served.
          mediaPath: `posts/${userA.id}/${randomUUID()}.png`,
          mediaUrl: 'https://example.invalid/seeded.png',
          mediaType: MediaType.IMAGE,
          createdAt,
        })),
        select: { id: true, createdAt: true },
      });

      // Expected order: createdAt DESC, then id DESC. PostgreSQL compares UUIDs byte by
      // byte, which matches comparing their lowercase text form.
      const expectedIds = seeded
        .toSorted(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
        )
        .map((post) => post.id);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      while (seen.length < expectedIds.length) {
        const query = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
        const response = await api('get', `/posts/feed${query}`, userB).expect(200);
        const page = readPage(response.body);
        expect(page.ids.length).toBeLessThanOrEqual(2);
        seen.push(...page.ids);
        cursor = page.nextCursor;
        pages += 1;
        if (cursor === null) {
          break;
        }
      }

      expect(pages).toBe(3);
      expect(seen.slice(0, expectedIds.length)).toEqual(expectedIds);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('rejects an invalid cursor or limit (400)', async () => {
      await api('get', '/posts/feed?cursor=not-a-cursor', userA).expect(400);
      await api('get', '/posts/feed?limit=51', userA).expect(400);
      await api('get', '/posts/feed?limit=0', userA).expect(400);
    });
  });
});
