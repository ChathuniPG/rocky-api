import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { FirebaseStorageService } from '../src/firebase/firebase-storage.service';
import { MAX_VIDEO_BYTES } from '../src/modules/uploads/uploads.constants';
import { TINY_PNG } from './fixtures/media.fixture';
import { cookieHeader } from './helpers/cookies';
import {
  deleteTestUser,
  type SignedUpTestUser,
  signUpTestUser,
  uniqueTestUserCredentials,
} from './helpers/test-user';

// Live test of POST /uploads against the real local database and the real Firebase project
// from .env (Auth and Storage). Prerequisites: `npm run db:up`, migrations applied, and a
// configured Firebase project with email/password sign-in and a Storage bucket.
//
// It signs up one uniquely named user and always deletes every uploaded object and the
// user afterwards, even if a step fails.

jest.setTimeout(60_000);

const credentials = uniqueTestUserCredentials('uploads');

describe('POST /uploads (e2e, live Firebase)', () => {
  let app: NestExpressApplication;
  let user: SignedUpTestUser;
  const uploadedPaths: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    user = await signUpTestUser(app, credentials);
  });

  afterAll(async () => {
    if (app) {
      const storage = app.get(FirebaseStorageService);
      await Promise.all(uploadedPaths.map((path) => storage.deleteObject(path)));
    }
    await deleteTestUser(app, credentials.email);
    await app?.close();
  });

  function postUpload(idToken: string | undefined): request.Test {
    return request(app.getHttpServer())
      .post('/api/v1/uploads')
      .set('Cookie', cookieHeader({ rocky_id: idToken }));
  }

  it('stores a real PNG and returns where it is', async () => {
    const response = await postUpload(user.idToken)
      .field('purpose', 'post')
      .attach('file', TINY_PNG, { filename: 'pixel.png', contentType: 'image/png' });

    // Recorded before any assertion, so afterAll deletes the object even if one fails.
    const body: unknown = response.body;
    if (typeof body === 'object' && body !== null && 'path' in body) {
      uploadedPaths.push(String(body.path));
    }

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      url: expect.stringMatching(/^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\//),
      path: expect.stringMatching(new RegExp(`^posts/${user.id}/[0-9a-f-]{36}\\.png$`)),
      mediaType: 'IMAGE',
      contentType: 'image/png',
      sizeBytes: TINY_PNG.length,
    });

    const metadata = await app.get(FirebaseStorageService).getObjectMetadata(uploadedPaths[0]);
    expect(metadata).toEqual({
      exists: true,
      contentType: 'image/png',
      sizeBytes: TINY_PNG.length,
    });

    // The download URL works without credentials and serves the exact bytes.
    const download = await fetch(String(response.body.url));
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await download.arrayBuffer())).toEqual(TINY_PNG);
  });

  it('rejects a text file renamed to .png (400), whatever its declared type', async () => {
    const response = await postUpload(user.idToken)
      .field('purpose', 'post')
      .attach('file', Buffer.from('this is plain text, not an image'), {
        filename: 'evil.png',
        contentType: 'image/png',
      })
      .expect(400);

    expect(response.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
  });

  it('rejects an invalid purpose (400)', async () => {
    await postUpload(user.idToken)
      .field('purpose', 'banner')
      .attach('file', TINY_PNG, 'pixel.png')
      .expect(400);
  });

  it('rejects a file over 25 MB (413) with the standard error body', async () => {
    const response = await postUpload(user.idToken)
      .field('purpose', 'post')
      .attach('file', Buffer.alloc(MAX_VIDEO_BYTES + 1), 'big.mp4')
      .expect(413);

    expect(response.body).toMatchObject({
      statusCode: 413,
      error: 'Payload Too Large',
      path: '/api/v1/uploads',
    });
  });

  it('rejects an unauthenticated request (401)', async () => {
    const response = await postUpload(undefined)
      .field('purpose', 'post')
      .attach('file', TINY_PNG, 'pixel.png')
      .expect(401);

    expect(response.body).toMatchObject({ statusCode: 401, error: 'Unauthorized' });
  });
});
