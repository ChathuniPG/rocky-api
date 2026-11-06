import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { App } from 'firebase-admin/app';
import { getDownloadURL, getStorage, type Storage } from 'firebase-admin/storage';
import { randomUUID } from 'node:crypto';
import type { EnvironmentVariables } from '../config/env.validation';
import { readErrorCode, readHttpStatus } from './firebase-error.utils';
import { FIREBASE_APP } from './firebase.constants';
import { FirebaseUnavailableError } from './firebase.errors';

/**
 * A Google Cloud Storage bucket handle. Derived from the Admin SDK's own types so this
 * module does not import `@google-cloud/storage` (a transitive dependency) directly.
 */
export type StorageBucket = ReturnType<Storage['bucket']>;

/**
 * Object names are unique (a fresh UUID per upload) and never overwritten, so browsers and
 * CDNs may cache them for a year without revalidating.
 */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** Input of {@link FirebaseStorageService.uploadObject}. */
export interface UploadObjectInput {
  /** Object path inside the bucket, e.g. "posts/{userId}/{uuid}.png". */
  path: string;
  /** The complete file contents. */
  data: Buffer;
  /** MIME type stored on the object and served back as Content-Type. */
  contentType: string;
}

/** Result of {@link FirebaseStorageService.getObjectMetadata}. */
export type StorageObjectMetadata =
  { exists: false } | { exists: true; contentType: string | undefined; sizeBytes: number };

const HTTP_NOT_FOUND = 404;

/**
 * Gives access to the configured Firebase Storage bucket (FIREBASE_STORAGE_BUCKET) and
 * the object operations used by uploads (#8) and posts (#7). Every Storage failure is
 * reported as {@link FirebaseUnavailableError}, so callers never see raw SDK errors.
 */
@Injectable()
export class FirebaseStorageService {
  private readonly logger = new Logger(FirebaseStorageService.name);
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

  /**
   * Uploads an object in a single request, with an immutable Cache-Control header and a
   * Firebase download token (needed by {@link getDownloadUrl}).
   *
   * @param input - Object path, contents and content type.
   * @throws {FirebaseUnavailableError} If Storage rejects or cannot be reached.
   */
  async uploadObject({ path, data, contentType }: UploadObjectInput): Promise<void> {
    try {
      await this.storageBucket.file(path).save(data, {
        // The file is already in memory and at most 25 MB: one request is cheaper than a
        // resumable upload session.
        resumable: false,
        contentType,
        metadata: {
          cacheControl: IMMUTABLE_CACHE_CONTROL,
          // Objects written through the Admin SDK get no download token, and
          // getDownloadURL() refuses objects without one. The token is the secret part
          // of the download URL, so it is never logged.
          metadata: { firebaseStorageDownloadTokens: randomUUID() },
        },
      });
    } catch (error: unknown) {
      throw this.unavailable('uploadObject', error);
    }
  }

  /**
   * Reads an object's metadata.
   *
   * @param path - Object path inside the bucket.
   * @returns `{ exists: false }` if there is no such object, otherwise its content type
   *   and size in bytes.
   * @throws {FirebaseUnavailableError} If Storage fails for any reason other than not-found.
   */
  async getObjectMetadata(path: string): Promise<StorageObjectMetadata> {
    try {
      const [metadata] = await this.storageBucket.file(path).getMetadata();
      // GCS returns the size as a decimal string; our objects are at most 25 MB, so a
      // number is exact.
      return {
        exists: true,
        contentType: metadata.contentType,
        sizeBytes: Number(metadata.size ?? 0),
      };
    } catch (error: unknown) {
      if (readHttpStatus(error) === HTTP_NOT_FOUND) {
        return { exists: false };
      }
      throw this.unavailable('getObjectMetadata', error);
    }
  }

  /**
   * Builds the long-lived, token-based Firebase download URL of an object, using the Admin
   * SDK's `getDownloadURL`.
   *
   * @param path - Object path inside the bucket.
   * @returns The download URL. It contains the download token: do not log it.
   * @throws {FirebaseUnavailableError} If the object is missing, has no download token or
   *   Storage cannot be reached.
   */
  async getDownloadUrl(path: string): Promise<string> {
    try {
      return await getDownloadURL(this.storageBucket.file(path));
    } catch (error: unknown) {
      throw this.unavailable('getDownloadUrl', error);
    }
  }

  /**
   * Deletes an object. Deleting an object that does not exist succeeds, so the call is
   * safe to repeat (e.g. in cleanup after a failed request).
   *
   * @param path - Object path inside the bucket.
   * @throws {FirebaseUnavailableError} If Storage fails for any reason other than not-found.
   */
  async deleteObject(path: string): Promise<void> {
    try {
      await this.storageBucket.file(path).delete({ ignoreNotFound: true });
    } catch (error: unknown) {
      throw this.unavailable('deleteObject', error);
    }
  }

  /** Logs the failed operation by code only (messages can echo URLs) and wraps the error. */
  private unavailable(operation: string, error: unknown): FirebaseUnavailableError {
    const code = readHttpStatus(error) ?? readErrorCode(error) ?? 'none';
    this.logger.error(`Firebase Storage ${operation} failed with error code: ${code}`);
    return new FirebaseUnavailableError({ cause: error });
  }
}
