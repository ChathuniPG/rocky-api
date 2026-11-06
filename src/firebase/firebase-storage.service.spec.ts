import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { App } from 'firebase-admin/app';
import { getDownloadURL, getStorage } from 'firebase-admin/storage';
import type { EnvironmentVariables } from '../config/env.validation';
import { FirebaseStorageService, IMMUTABLE_CACHE_CONTROL } from './firebase-storage.service';
import { FirebaseUnavailableError } from './firebase.errors';

const mockFile = {
  save: jest.fn<Promise<void>, unknown[]>(),
  getMetadata: jest.fn<Promise<[Record<string, unknown>]>, unknown[]>(),
  delete: jest.fn<Promise<unknown>, unknown[]>(),
};
const mockBucketHandle = {
  name: 'rocky-test-1234.firebasestorage.app',
  file: jest.fn(() => mockFile),
};
const mockBucket = jest.fn(() => mockBucketHandle);

jest.mock('firebase-admin/storage', () => ({
  getStorage: jest.fn(() => ({ bucket: mockBucket })),
  getDownloadURL: jest.fn(),
}));

const mockGetDownloadURL = jest.mocked(getDownloadURL);

const fakeApp: App = { name: 'rocky-api-test', options: {} };
const FIREBASE_STORAGE_BUCKET = 'rocky-test-1234.firebasestorage.app';
const PATH = 'posts/user-1/0b6f6a52-1c1e-4c43-9a2f-1d1b2f3c4d5e.png';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Shape of a GCS ApiError: a numeric HTTP status in `code`. */
function storageError(code: number): Error & { code: number } {
  return Object.assign(new Error(`storage error ${code}`), { code });
}

function createService(): FirebaseStorageService {
  return new FirebaseStorageService(
    fakeApp,
    new ConfigService<EnvironmentVariables, true>({ FIREBASE_STORAGE_BUCKET }),
  );
}

describe('FirebaseStorageService', () => {
  let service: FirebaseStorageService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    service = createService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('bucket', () => {
    it('exposes the bucket named by FIREBASE_STORAGE_BUCKET on the injected app', () => {
      expect(getStorage).toHaveBeenCalledWith(fakeApp);
      expect(mockBucket).toHaveBeenCalledWith(FIREBASE_STORAGE_BUCKET);
      expect(service.bucket()).toBe(mockBucketHandle);
    });

    it('creates the bucket handle once and reuses it', () => {
      service.bucket();
      service.bucket();

      expect(mockBucket).toHaveBeenCalledTimes(1);
    });
  });

  describe('uploadObject', () => {
    it('saves in one request with content type, immutable caching and a download token', async () => {
      mockFile.save.mockResolvedValue(undefined);
      const data = Buffer.from([1, 2, 3]);

      await service.uploadObject({ path: PATH, data, contentType: 'image/png' });

      expect(mockBucketHandle.file).toHaveBeenCalledWith(PATH);
      expect(mockFile.save).toHaveBeenCalledWith(data, {
        resumable: false,
        contentType: 'image/png',
        metadata: {
          cacheControl: IMMUTABLE_CACHE_CONTROL,
          metadata: { firebaseStorageDownloadTokens: expect.stringMatching(UUID_PATTERN) },
        },
      });
    });

    it('generates a different download token for each upload', async () => {
      mockFile.save.mockResolvedValue(undefined);
      const input = { path: PATH, data: Buffer.from([1]), contentType: 'image/png' };

      await service.uploadObject(input);
      await service.uploadObject(input);

      const tokens = mockFile.save.mock.calls.map((call) => JSON.stringify(call[1]));
      expect(tokens[0]).not.toBe(tokens[1]);
    });

    it('wraps a Storage failure in FirebaseUnavailableError', async () => {
      const cause = storageError(503);
      mockFile.save.mockRejectedValue(cause);

      const promise = service.uploadObject({
        path: PATH,
        data: Buffer.from([1]),
        contentType: 'image/png',
      });

      await expect(promise).rejects.toBeInstanceOf(FirebaseUnavailableError);
      await expect(promise).rejects.toMatchObject({ cause });
    });
  });

  describe('getObjectMetadata', () => {
    it('returns the content type and the size as a number', async () => {
      mockFile.getMetadata.mockResolvedValue([{ contentType: 'video/mp4', size: '1048576' }]);

      await expect(service.getObjectMetadata(PATH)).resolves.toEqual({
        exists: true,
        contentType: 'video/mp4',
        sizeBytes: 1_048_576,
      });
    });

    it('reports a missing object (404) as exists: false', async () => {
      mockFile.getMetadata.mockRejectedValue(storageError(404));

      await expect(service.getObjectMetadata(PATH)).resolves.toEqual({ exists: false });
    });

    it('wraps any other failure in FirebaseUnavailableError', async () => {
      mockFile.getMetadata.mockRejectedValue(storageError(403));

      await expect(service.getObjectMetadata(PATH)).rejects.toBeInstanceOf(
        FirebaseUnavailableError,
      );
    });
  });

  describe('getDownloadUrl', () => {
    it('returns the URL from the Admin SDK for the object', async () => {
      mockGetDownloadURL.mockResolvedValue('https://firebasestorage.googleapis.com/v0/b/x/o/y');

      await expect(service.getDownloadUrl(PATH)).resolves.toBe(
        'https://firebasestorage.googleapis.com/v0/b/x/o/y',
      );
      expect(mockBucketHandle.file).toHaveBeenCalledWith(PATH);
      expect(mockGetDownloadURL).toHaveBeenCalledWith(mockFile);
    });

    it('wraps a failure (e.g. no download token) in FirebaseUnavailableError', async () => {
      mockGetDownloadURL.mockRejectedValue(
        Object.assign(new Error('No download token'), { code: 'storage/no-download-token' }),
      );

      await expect(service.getDownloadUrl(PATH)).rejects.toBeInstanceOf(FirebaseUnavailableError);
    });
  });

  describe('deleteObject', () => {
    it('deletes the object and treats not-found as success', async () => {
      mockFile.delete.mockResolvedValue([{}]);

      await service.deleteObject(PATH);

      expect(mockBucketHandle.file).toHaveBeenCalledWith(PATH);
      expect(mockFile.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
    });

    it('wraps a Storage failure in FirebaseUnavailableError', async () => {
      mockFile.delete.mockRejectedValue(storageError(500));

      await expect(service.deleteObject(PATH)).rejects.toBeInstanceOf(FirebaseUnavailableError);
    });
  });

  it('logs only the operation and error code, never the error message', async () => {
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    mockFile.delete.mockRejectedValue(storageError(500));

    await expect(service.deleteObject(PATH)).rejects.toThrow();

    expect(errorLog).toHaveBeenCalledWith(
      'Firebase Storage deleteObject failed with error code: 500',
    );
  });
});
