import { ConfigService } from '@nestjs/config';
import type { App } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import type { EnvironmentVariables } from '../config/env.validation';
import { FirebaseStorageService } from './firebase-storage.service';

const mockBucketHandle = { name: 'rocky-test-1234.firebasestorage.app' };
const mockBucket = jest.fn(() => mockBucketHandle);

jest.mock('firebase-admin/storage', () => ({
  getStorage: jest.fn(() => ({ bucket: mockBucket })),
}));

const fakeApp: App = { name: 'rocky-api-test', options: {} };
const FIREBASE_STORAGE_BUCKET = 'rocky-test-1234.firebasestorage.app';

function createService(): FirebaseStorageService {
  return new FirebaseStorageService(
    fakeApp,
    new ConfigService<EnvironmentVariables, true>({ FIREBASE_STORAGE_BUCKET }),
  );
}

describe('FirebaseStorageService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('exposes the bucket named by FIREBASE_STORAGE_BUCKET on the injected app', () => {
    const service = createService();

    expect(getStorage).toHaveBeenCalledWith(fakeApp);
    expect(mockBucket).toHaveBeenCalledWith(FIREBASE_STORAGE_BUCKET);
    expect(service.bucket()).toBe(mockBucketHandle);
  });

  it('creates the bucket handle once and reuses it', () => {
    const service = createService();

    service.bucket();
    service.bucket();

    expect(mockBucket).toHaveBeenCalledTimes(1);
  });
});
