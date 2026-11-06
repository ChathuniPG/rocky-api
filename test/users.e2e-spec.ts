import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { FirebaseStorageService } from '../src/firebase/firebase-storage.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TINY_PNG } from './fixtures/media.fixture';
import { cookieHeader } from './helpers/cookies';
import {
  deleteTestUser,
  type SignedUpTestUser,
  signUpTestUser,
  uniqueTestUserCredentials,
} from './helpers/test-user';

// Live test of the users endpoints against the real local database and the real Firebase
// project from .env (Auth and Storage). Prerequisites: `npm run db:up`, migrations
// applied, and a configured Firebase project with email/password sign-in and a bucket.
//
// Two uniquely named users. A has the usual "e2e_..." username. B's username has a period
// instead of the underscore and B's display name has neither "_" nor "%", so a search for
// those characters must not find B. afterAll always deletes every uploaded object and both
// users; their posts, saves and follows cascade.
//
// The tests build on each other and run in file order.

jest.setTimeout(60_000);

const credentialsA = uniqueTestUserCredentials('users-a');
const baseCredentialsB = uniqueTestUserCredentials('users-b');
const credentialsB = { ...baseCredentialsB, username: baseCredentialsB.username.replace('_', '.') };
// C only searches: it sees exactly A and B for the run token.
const credentialsC = uniqueTestUserCredentials('users-c');
/** Shared by A's and B's display names only, so it matches exactly those two users. */
const runToken = randomBytes(5).toString('hex');
const displayNameA = `Wombat ${runToken}`;
/** Unrelated to B's username, so a match on "Quokka" can only come from the display name. */
const displayNameB = `Quokka ${runToken}`;

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

/** Reads the item IDs and next cursor of a page. */
function readPage(body: unknown): { ids: string[]; nextCursor: string | null } {
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new Error('Response body is not a page');
  }
  const ids = body.items.map((item: unknown) => readString(item, 'id'));
  const nextCursor = typeof body.nextCursor === 'string' ? body.nextCursor : null;
  return { ids, nextCursor };
}

describe('Users (e2e, live Firebase)', () => {
  let app: NestExpressApplication;
  let userA: SignedUpTestUser;
  let userB: SignedUpTestUser;
  let userC: SignedUpTestUser;
  const uploadedPaths: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    userA = await signUpTestUser(app, credentialsA, displayNameA);
    userB = await signUpTestUser(app, credentialsB, displayNameB);
    userC = await signUpTestUser(app, credentialsC);
  });

  afterAll(async () => {
    if (app) {
      const storage = app.get(FirebaseStorageService);
      await Promise.all(uploadedPaths.map((path) => storage.deleteObject(path)));
    }
    // Users are deleted from PostgreSQL first: their posts, saves and follows cascade.
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

  async function upload(user: SignedUpTestUser, purpose: 'avatar' | 'post'): Promise<string> {
    const response = await api('post', '/uploads', user)
      .field('purpose', purpose)
      .attach('file', TINY_PNG, { filename: 'pixel.png', contentType: 'image/png' })
      .expect(201);
    const path = readString(response.body, 'path');
    uploadedPaths.push(path);
    return path;
  }

  async function objectExists(path: string): Promise<boolean> {
    const metadata = await app.get(FirebaseStorageService).getObjectMetadata(path);
    return metadata.exists;
  }

  async function searchIds(user: SignedUpTestUser, query: string): Promise<string[]> {
    const response = await api('get', `/users/search?limit=50&${query}`, user).expect(200);
    return readPage(response.body).ids;
  }

  describe('sign-up', () => {
    it('rejects a reserved username (400) before creating any account', async () => {
      const credentials = { ...uniqueTestUserCredentials('users-reserved'), username: 'Settings' };

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/signup')
        .send({ ...credentials, displayName: 'Reserved' })
        .expect(400);

      expect(response.body).toMatchObject({ statusCode: 400 });
      const row = await app.get(PrismaService).user.findUnique({ where: { username: 'settings' } });
      expect(row).toBeNull();
    });
  });

  describe('profiles', () => {
    it("shows B's public profile to A, without private fields", async () => {
      const response = await api('get', `/users/${userB.username}`, userA).expect(200);

      expect(response.body).toEqual({
        id: userB.id,
        username: userB.username,
        displayName: displayNameB,
        bio: null,
        avatarUrl: null,
        createdAt: expect.any(String),
        postCount: 0,
        followerCount: 0,
        followingCount: 0,
        isFollowing: false,
        isMe: false,
      });
    });

    it('marks your own profile with isMe and finds it case-insensitively', async () => {
      const response = await api('get', `/users/${userA.username.toUpperCase()}`, userA).expect(
        200,
      );

      expect(response.body).toMatchObject({ id: userA.id, isMe: true, isFollowing: false });
    });

    it('reports an unknown username (404) and an impossible one (400)', async () => {
      await api('get', '/users/nobody_has_this_name_x', userA).expect(404);
      await api('get', '/users/no$such', userA).expect(400);
    });

    it('rejects unauthenticated requests (401)', async () => {
      await api('get', `/users/${userB.username}`, undefined).expect(401);
      await api('get', '/users/search?q=e2e', undefined).expect(401);
    });
  });

  describe('follows', () => {
    it('is idempotent: following twice leaves followerCount at 1', async () => {
      const first = await api('post', `/users/${userB.id}/follow`, userA).expect(200);
      const second = await api('post', `/users/${userB.id}/follow`, userA).expect(200);

      expect(first.body).toEqual({ isFollowing: true, followerCount: 1 });
      expect(second.body).toEqual({ isFollowing: true, followerCount: 1 });
    });

    it('shows the follow on both profiles', async () => {
      const profileB = await api('get', `/users/${userB.username}`, userA).expect(200);
      const profileA = await api('get', `/users/${userA.username}`, userB).expect(200);

      expect(profileB.body).toMatchObject({ followerCount: 1, isFollowing: true, isMe: false });
      expect(profileA.body).toMatchObject({
        followingCount: 1,
        followerCount: 0,
        isFollowing: false,
      });
    });

    it('rejects following yourself (400), an unknown user (404) and a non-UUID (400)', async () => {
      await api('post', `/users/${userA.id}/follow`, userA).expect(400);
      await api('post', `/users/${randomUUID()}/follow`, userA).expect(404);
      await api('post', '/users/not-a-uuid/follow', userA).expect(400);
    });
  });

  describe('search', () => {
    it('proves that Prisma does not escape LIKE wildcards in contains', async () => {
      const prisma = app.get(PrismaService);
      const ids = [userA.id, userB.id];

      // Neither display name contains "_" or "%", yet an unescaped "_" (any one character)
      // and "%" (any characters) match both. This is why UsersService escapes the input.
      const unescaped = await prisma.user.findMany({
        where: { id: { in: ids }, displayName: { contains: '_' } },
      });
      const unescapedPercent = await prisma.user.findMany({
        where: { id: { in: ids }, displayName: { contains: '%' } },
      });
      const escaped = await prisma.user.findMany({
        where: { id: { in: ids }, displayName: { contains: '\\_' } },
      });

      expect(unescaped).toHaveLength(2);
      expect(unescapedPercent).toHaveLength(2);
      expect(escaped).toHaveLength(0);
    });

    it('finds a user by partial username, case-insensitively', async () => {
      const fragment = userB.username.slice(4, 12).toUpperCase();

      expect(await searchIds(userA, `q=${encodeURIComponent(fragment)}`)).toContain(userB.id);
    });

    it('finds a user by partial display name', async () => {
      // "kka <token>": only B's display name, not A's.
      const fragment = displayNameB.slice(3).toUpperCase();

      expect(await searchIds(userA, `q=${encodeURIComponent(fragment)}`)).toEqual([userB.id]);
    });

    it('never returns the searching user', async () => {
      expect(await searchIds(userA, `q=${userA.username}`)).not.toContain(userA.id);
    });

    it('honours filter=following', async () => {
      // A follows B; B does not follow A.
      expect(await searchIds(userA, `q=${userB.username}&filter=following`)).toEqual([userB.id]);
      expect(await searchIds(userB, `q=${userA.username}&filter=following`)).toEqual([]);
      expect(await searchIds(userB, `q=${userA.username}&filter=all`)).toEqual([userA.id]);
    });

    it('matches "_" and "%" literally instead of as wildcards', async () => {
      // B has neither character in username or display name.
      expect(await searchIds(userA, `q=${encodeURIComponent('_')}`)).not.toContain(userB.id);
      expect(await searchIds(userA, `q=${encodeURIComponent('%')}`)).not.toContain(userB.id);
      // A's username does contain "_", so the literal match still works.
      expect(await searchIds(userB, `q=${encodeURIComponent(userA.username)}`)).toEqual([userA.id]);
    });

    it('pages through results by username without gaps or repeats', async () => {
      // The run token matches exactly A and B; C sees both.
      const first = await api('get', `/users/search?q=${runToken}&limit=1`, userC).expect(200);
      const firstPage = readPage(first.body);
      expect(firstPage.ids).toHaveLength(1);
      expect(firstPage.nextCursor).not.toBeNull();

      const cursor = encodeURIComponent(firstPage.nextCursor ?? '');
      const second = await api(
        'get',
        `/users/search?q=${runToken}&limit=1&cursor=${cursor}`,
        userC,
      ).expect(200);
      const secondPage = readPage(second.body);

      expect(secondPage.nextCursor).toBeNull();
      expect([...firstPage.ids, ...secondPage.ids].toSorted()).toEqual(
        [userA.id, userB.id].toSorted(),
      );
    });

    it('validates q, filter and cursor (400)', async () => {
      await api('get', '/users/search', userA).expect(400);
      await api('get', '/users/search?q=%20%20', userA).expect(400);
      await api('get', `/users/search?q=${'a'.repeat(51)}`, userA).expect(400);
      await api('get', '/users/search?q=a&filter=followers', userA).expect(400);
      await api('get', '/users/search?q=a&cursor=not-a-cursor', userA).expect(400);
    });
  });

  describe('unfollow', () => {
    it('is idempotent: unfollowing twice leaves followerCount at 0', async () => {
      const first = await api('delete', `/users/${userB.id}/follow`, userA).expect(200);
      const second = await api('delete', `/users/${userB.id}/follow`, userA).expect(200);

      expect(first.body).toEqual({ isFollowing: false, followerCount: 0 });
      expect(second.body).toEqual({ isFollowing: false, followerCount: 0 });
      expect(await searchIds(userA, `q=${userB.username}&filter=following`)).toEqual([]);
    });
  });

  describe('profile update', () => {
    it('updates profile and settings, returning the /auth/me body', async () => {
      const response = await api('patch', '/users/me', userA)
        .send({
          displayName: '  Alice Updated ',
          bio: '  Hello there  ',
          notificationsEnabled: false,
          language: 'si',
        })
        .expect(200);

      expect(response.body).toMatchObject({
        id: userA.id,
        email: userA.email,
        displayName: 'Alice Updated',
        bio: 'Hello there',
        notificationsEnabled: false,
        language: 'si',
      });
      expect(response.body).not.toHaveProperty('avatarPath');
      expect(response.body).not.toHaveProperty('firebaseUid');
      const me = await api('get', '/auth/me', userA).expect(200);
      expect(me.body).toEqual(response.body);
    });

    it('clears the bio with an empty string', async () => {
      const response = await api('patch', '/users/me', userA).send({ bio: '' }).expect(200);

      expect(response.body).toMatchObject({ bio: null });
    });

    it('rejects an empty body, invalid values and read-only fields (400)', async () => {
      await api('patch', '/users/me', userA).send({}).expect(400);
      await api('patch', '/users/me', userA).send({ displayName: '   ' }).expect(400);
      await api('patch', '/users/me', userA).send({ language: 'fr' }).expect(400);
      await api('patch', '/users/me', userA).send({ username: 'renamed' }).expect(400);
      await api('patch', '/users/me', userA)
        .send({ avatarUrl: 'https://evil.example' })
        .expect(400);
    });

    it('sets, replaces and removes the avatar, deleting each replaced image', async () => {
      const firstPath = await upload(userA, 'avatar');
      const first = await api('patch', '/users/me', userA)
        .send({ avatarPath: firstPath })
        .expect(200);
      const firstUrl = readString(first.body, 'avatarUrl');
      expect(firstUrl).toMatch(/^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\//);
      const profile = await api('get', `/users/${userA.username}`, userB).expect(200);
      expect(profile.body).toMatchObject({ avatarUrl: firstUrl });

      // Re-sending the current path changes nothing and keeps the object.
      await api('patch', '/users/me', userA).send({ avatarPath: firstPath }).expect(200);
      expect(await objectExists(firstPath)).toBe(true);

      const secondPath = await upload(userA, 'avatar');
      const second = await api('patch', '/users/me', userA)
        .send({ avatarPath: secondPath })
        .expect(200);
      expect(readString(second.body, 'avatarUrl')).not.toBe(firstUrl);
      expect(await objectExists(firstPath)).toBe(false);

      const removed = await api('patch', '/users/me', userA).send({ avatarPath: null }).expect(200);
      expect(removed.body).toMatchObject({ avatarUrl: null });
      expect(await objectExists(secondPath)).toBe(false);
    });

    it("rejects another user's avatar (403), a post upload and a missing object (400)", async () => {
      const foreignPath = await upload(userB, 'avatar');
      const postPath = await upload(userA, 'post');

      await api('patch', '/users/me', userA).send({ avatarPath: foreignPath }).expect(403);
      await api('patch', '/users/me', userA).send({ avatarPath: postPath }).expect(400);
      await api('patch', '/users/me', userA)
        .send({ avatarPath: `avatars/${userA.id}/${randomUUID()}.png` })
        .expect(400);
      // B's avatar object is untouched.
      expect(await objectExists(foreignPath)).toBe(true);
    });
  });

  describe('user posts and saved posts', () => {
    let olderPostId: string;
    let newerPostId: string;

    it("lists a user's posts newest first and counts them on the profile", async () => {
      // Uploads finish before each post request starts: supertest must not run two
      // requests on the same server handle at once.
      const olderMediaPath = await upload(userA, 'post');
      const older = await api('post', '/posts', userA)
        .send({ mediaPath: olderMediaPath })
        .expect(201);
      const newerMediaPath = await upload(userA, 'post');
      const newer = await api('post', '/posts', userA)
        .send({ mediaPath: newerMediaPath })
        .expect(201);
      olderPostId = readString(older.body, 'id');
      newerPostId = readString(newer.body, 'id');

      const posts = await api('get', `/users/${userA.username}/posts`, userB).expect(200);
      expect(readPage(posts.body)).toEqual({ ids: [newerPostId, olderPostId], nextCursor: null });

      const firstPage = await api('get', `/users/${userA.username}/posts?limit=1`, userB).expect(
        200,
      );
      const { ids, nextCursor } = readPage(firstPage.body);
      expect(ids).toEqual([newerPostId]);
      const secondPage = await api(
        'get',
        `/users/${userA.username}/posts?limit=1&cursor=${encodeURIComponent(nextCursor ?? '')}`,
        userB,
      ).expect(200);
      expect(readPage(secondPage.body)).toEqual({ ids: [olderPostId], nextCursor: null });

      const profile = await api('get', `/users/${userA.username}`, userB).expect(200);
      expect(profile.body).toMatchObject({ postCount: 2 });
      await api('get', '/users/nobody_has_this_name_x/posts', userB).expect(404);
    });

    it('lists saved posts most recently saved first, only for the saver', async () => {
      // Saved in the opposite order to their creation.
      await api('post', `/posts/${newerPostId}/save`, userB).expect(200);
      await api('post', `/posts/${olderPostId}/save`, userB).expect(200);

      const saved = await api('get', '/users/me/saved', userB).expect(200);
      expect(readPage(saved.body)).toEqual({ ids: [olderPostId, newerPostId], nextCursor: null });
      expect(saved.body).toMatchObject({ items: [{ savedByMe: true }, { savedByMe: true }] });

      const firstPage = await api('get', '/users/me/saved?limit=1', userB).expect(200);
      const { nextCursor } = readPage(firstPage.body);
      const secondPage = await api(
        'get',
        `/users/me/saved?limit=1&cursor=${encodeURIComponent(nextCursor ?? '')}`,
        userB,
      ).expect(200);
      expect(readPage(secondPage.body)).toEqual({ ids: [newerPostId], nextCursor: null });

      const savedByA = await api('get', '/users/me/saved', userA).expect(200);
      expect(readPage(savedByA.body).ids).toEqual([]);
    });
  });
});
