import { BadRequestException, Logger, PayloadTooLargeException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FirebaseStorageService,
  type UploadObjectInput,
} from '../../firebase/firebase-storage.service';
import { FirebaseUnavailableError } from '../../firebase/firebase.errors';
import { MediaType } from '../../generated/prisma/enums';
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from './uploads.constants';
import { AVATAR_TYPE_MESSAGE, UNSUPPORTED_TYPE_MESSAGE, UploadsService } from './uploads.service';

const USER_ID = '6f1c1b1e-8d5a-4a4e-9a51-2b3c4d5e6f70';
const URL = 'https://firebasestorage.googleapis.com/v0/b/bucket/o/x?alt=media&token=t';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

const SIGNATURES = {
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  webp: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]),
  mp4: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom')]),
  webm: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84, ...Buffer.from('webm')]),
} as const;

/** A file of exactly `size` bytes that starts with the given signature. */
function fileOf(signature: Buffer, size = 64): { buffer: Buffer } {
  const buffer = Buffer.alloc(size);
  signature.copy(buffer);
  return { buffer };
}

describe('UploadsService', () => {
  const storage = {
    uploadObject: jest.fn<Promise<void>, [UploadObjectInput]>(),
    getDownloadUrl: jest.fn<Promise<string>, [string]>(),
    deleteObject: jest.fn<Promise<void>, [string]>(),
  };
  let service: UploadsService;

  beforeEach(async () => {
    jest.resetAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    storage.uploadObject.mockResolvedValue(undefined);
    storage.getDownloadUrl.mockResolvedValue(URL);
    storage.deleteObject.mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [UploadsService, { provide: FirebaseStorageService, useValue: storage }],
    }).compile();
    service = moduleRef.get(UploadsService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('post media', () => {
    it.each([
      ['jpeg', 'image/jpeg', MediaType.IMAGE, 'jpg'],
      ['png', 'image/png', MediaType.IMAGE, 'png'],
      ['webp', 'image/webp', MediaType.IMAGE, 'webp'],
      ['mp4', 'video/mp4', MediaType.VIDEO, 'mp4'],
      ['webm', 'video/webm', MediaType.VIDEO, 'webm'],
    ] as const)(
      'stores a %s under posts/{userId}/{uuid}.%s with the detected type',
      async (format, contentType, mediaType, extension) => {
        const file = fileOf(SIGNATURES[format], 100);

        const result = await service.upload(USER_ID, 'post', file);

        expect(result).toEqual({
          url: URL,
          path: expect.any(String),
          mediaType,
          contentType,
          sizeBytes: 100,
        });
        expect(result.path).toMatch(new RegExp(`^posts/${USER_ID}/${UUID}\\.${extension}$`));
        expect(storage.uploadObject).toHaveBeenCalledWith({
          path: result.path,
          data: file.buffer,
          contentType,
        });
        expect(storage.getDownloadUrl).toHaveBeenCalledWith(result.path);
      },
    );

    it('uses a fresh object name for every upload', async () => {
      const first = await service.upload(USER_ID, 'post', fileOf(SIGNATURES.png));
      const second = await service.upload(USER_ID, 'post', fileOf(SIGNATURES.png));

      expect(first.path).not.toBe(second.path);
    });

    it('accepts an image of exactly 5 MB and a video of exactly 25 MB', async () => {
      await expect(
        service.upload(USER_ID, 'post', fileOf(SIGNATURES.jpeg, MAX_IMAGE_BYTES)),
      ).resolves.toMatchObject({ sizeBytes: MAX_IMAGE_BYTES });
      await expect(
        service.upload(USER_ID, 'post', fileOf(SIGNATURES.mp4, MAX_VIDEO_BYTES)),
      ).resolves.toMatchObject({ sizeBytes: MAX_VIDEO_BYTES });
    });

    it('rejects an image over 5 MB with 413', async () => {
      const promise = service.upload(USER_ID, 'post', fileOf(SIGNATURES.png, MAX_IMAGE_BYTES + 1));

      await expect(promise).rejects.toBeInstanceOf(PayloadTooLargeException);
      await expect(promise).rejects.toThrow('Images must be 5 MB or smaller');
      expect(storage.uploadObject).not.toHaveBeenCalled();
    });

    it('accepts a video larger than the image limit', async () => {
      await expect(
        service.upload(USER_ID, 'post', fileOf(SIGNATURES.webm, MAX_IMAGE_BYTES + 1)),
      ).resolves.toMatchObject({ mediaType: MediaType.VIDEO });
    });

    it('rejects a video over 25 MB with 413', async () => {
      await expect(
        service.upload(USER_ID, 'post', fileOf(SIGNATURES.mp4, MAX_VIDEO_BYTES + 1)),
      ).rejects.toThrow('Videos must be 25 MB or smaller');
    });
  });

  describe('avatars', () => {
    it('stores an image under avatars/{userId}/', async () => {
      const result = await service.upload(USER_ID, 'avatar', fileOf(SIGNATURES.webp));

      expect(result.path).toMatch(new RegExp(`^avatars/${USER_ID}/${UUID}\\.webp$`));
    });

    it.each(['mp4', 'webm'] as const)('rejects a %s video with 400', async (format) => {
      const promise = service.upload(USER_ID, 'avatar', fileOf(SIGNATURES[format]));

      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      await expect(promise).rejects.toThrow(AVATAR_TYPE_MESSAGE);
      expect(storage.uploadObject).not.toHaveBeenCalled();
    });

    it('rejects an avatar over 5 MB with 413', async () => {
      await expect(
        service.upload(USER_ID, 'avatar', fileOf(SIGNATURES.jpeg, MAX_IMAGE_BYTES + 1)),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
    });
  });

  describe('type detection', () => {
    it.each([
      ['text bytes', Buffer.from('not an image, whatever the file name says')],
      ['an empty file', Buffer.alloc(0)],
      ['a GIF', Buffer.from('GIF89a')],
    ])('rejects %s with 400 without touching Storage', async (_name, buffer) => {
      const promise = service.upload(USER_ID, 'post', { buffer });

      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      await expect(promise).rejects.toThrow(UNSUPPORTED_TYPE_MESSAGE);
      expect(storage.uploadObject).not.toHaveBeenCalled();
    });

    it('checks the type before the size, so a huge unsupported file is a 400', async () => {
      const buffer = Buffer.alloc(MAX_VIDEO_BYTES + 1, 0x20);

      await expect(service.upload(USER_ID, 'post', { buffer })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('Storage failures', () => {
    it('passes an upload failure through without calling getDownloadUrl', async () => {
      storage.uploadObject.mockRejectedValue(new FirebaseUnavailableError());

      await expect(service.upload(USER_ID, 'post', fileOf(SIGNATURES.png))).rejects.toBeInstanceOf(
        FirebaseUnavailableError,
      );
      expect(storage.getDownloadUrl).not.toHaveBeenCalled();
    });

    it('deletes the stored object when the download URL fails, then rethrows', async () => {
      const failure = new FirebaseUnavailableError();
      storage.getDownloadUrl.mockRejectedValue(failure);

      await expect(service.upload(USER_ID, 'post', fileOf(SIGNATURES.png))).rejects.toBe(failure);

      const [{ path }] = storage.uploadObject.mock.calls[0];
      expect(storage.deleteObject).toHaveBeenCalledWith(path);
    });

    it('still rethrows the original error when the cleanup delete fails too', async () => {
      const failure = new FirebaseUnavailableError();
      storage.getDownloadUrl.mockRejectedValue(failure);
      storage.deleteObject.mockRejectedValue(new FirebaseUnavailableError());

      await expect(service.upload(USER_ID, 'post', fileOf(SIGNATURES.png))).rejects.toBe(failure);
    });
  });
});
