import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { App } from 'firebase-admin/app';
import { getStorage, type Storage } from 'firebase-admin/storage';
import type { EnvironmentVariables } from '../config/env.validation';
import { FIREBASE_APP } from './firebase.constants';

/**
 * A Google Cloud Storage bucket handle. Derived from the Admin SDK's own types so this
 * module does not import `@google-cloud/storage` (a transitive dependency) directly.
 */
export type StorageBucket = ReturnType<Storage['bucket']>;

/**
 * Gives access to the configured Firebase Storage bucket (FIREBASE_STORAGE_BUCKET).
 * Uploads are implemented by the uploads module (#8) on top of {@link bucket}.
 */
@Injectable()
export class FirebaseStorageService {
  private readonly storageBucket: StorageBucket;

  constructor(@Inject(FIREBASE_APP) app: App, config: ConfigService<EnvironmentVariables, true>) {
    // Creating the handle makes no network call; it is reused for every request.
    this.storageBucket = getStorage(app).bucket(
      config.get('FIREBASE_STORAGE_BUCKET', { infer: true }),
    );
  }

  /**
   * Returns the configured bucket.
   *
   * @returns The bucket handle for FIREBASE_STORAGE_BUCKET.
   */
  bucket(): StorageBucket {
    return this.storageBucket;
  }
}
