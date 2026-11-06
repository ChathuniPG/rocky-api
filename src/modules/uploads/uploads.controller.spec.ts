import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { buildUser } from '../../../test/fixtures/user.fixture';
import { configureApp } from '../../app.setup';
import type { User } from '../../generated/prisma/client';
import { MediaType } from '../../generated/prisma/enums';
import type { UploadResponseDto } from './dto/upload-response.dto';
import { UploadsController } from './uploads.controller';
import { MAX_VIDEO_BYTES } from './uploads.constants';
import { UploadsService } from './uploads.service';

// HTTP-level tests with UploadsService mocked: real routing, multer parsing and limits,
// ValidationPipe and exception filter, but no Firebase.

const user = buildUser();
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const response: UploadResponseDto = {
  url: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/x?alt=media&token=t',
  path: `posts/${user.id}/0b6f6a52-1c1e-4c43-9a2f-1d1b2f3c4d5e.png`,
  mediaType: MediaType.IMAGE,
  contentType: 'image/png',
  sizeBytes: PNG.length,
};

/** Stands in for FirebaseAuthGuard: lets every request through as `user`. */
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest<{ user?: User }>().user = user;
    return true;
  }
}

describe('UploadsController (HTTP)', () => {
  const uploadsService = { upload: jest.fn() };
  let app: NestExpressApplication;

  beforeEach(async () => {
    jest.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [UploadsController],
      providers: [
        { provide: UploadsService, useValue: uploadsService },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
      ],
    }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  function postUpload(): request.Test {
    return request(app.getHttpServer()).post('/api/v1/uploads');
  }

  it('passes the user ID, purpose and file bytes to the service and returns 201', async () => {
    uploadsService.upload.mockResolvedValue(response);

    const res = await postUpload()
      .field('purpose', 'post')
      .attach('file', PNG, { filename: 'photo.png', contentType: 'image/png' })
      .expect(201);

    expect(res.body).toEqual(response);
    expect(uploadsService.upload).toHaveBeenCalledWith(
      user.id,
      'post',
      expect.objectContaining({ buffer: PNG }),
    );
  });

  it('rejects a request without a file (400)', async () => {
    const res = await postUpload().field('purpose', 'post').expect(400);

    expect(res.body).toMatchObject({ statusCode: 400, path: '/api/v1/uploads' });
    expect(uploadsService.upload).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['unknown', 'banner'],
  ])('rejects a %s purpose (400)', async (_name, purpose) => {
    const req = postUpload();
    if (purpose !== undefined) {
      void req.field('purpose', purpose);
    }

    const res = await req.attach('file', PNG, 'photo.png').expect(400);

    expect(res.body.message).toEqual(['purpose must be one of: avatar, post']);
    expect(uploadsService.upload).not.toHaveBeenCalled();
  });

  it('rejects an extra text field (400)', async () => {
    await postUpload()
      .field('purpose', 'post')
      .field('caption', 'hello')
      .attach('file', PNG, 'photo.png')
      .expect(400);

    expect(uploadsService.upload).not.toHaveBeenCalled();
  });

  it('rejects a file sent under another field name (400)', async () => {
    const res = await postUpload()
      .field('purpose', 'post')
      .attach('image', PNG, 'photo.png')
      .expect(400);

    expect(res.body).toMatchObject({ message: 'Unexpected file field - image' });
    expect(uploadsService.upload).not.toHaveBeenCalled();
  });

  it('rejects a second file (400)', async () => {
    const res = await postUpload()
      .field('purpose', 'post')
      .attach('file', PNG, 'a.png')
      .attach('file', PNG, 'b.png')
      .expect(400);

    expect(res.body).toMatchObject({ statusCode: 400 });
    expect(uploadsService.upload).not.toHaveBeenCalled();
  });

  it('rejects a file over 25 MB with 413 and the standard error body', async () => {
    const res = await postUpload()
      .field('purpose', 'post')
      .attach('file', Buffer.alloc(MAX_VIDEO_BYTES + 1), 'big.mp4')
      .expect(413);

    expect(res.body).toMatchObject({
      statusCode: 413,
      error: 'Payload Too Large',
      message: 'File too large',
      path: '/api/v1/uploads',
    });
    expect(uploadsService.upload).not.toHaveBeenCalled();
  });
});
