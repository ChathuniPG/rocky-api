import { BadRequestException, Injectable, Logger, PayloadTooLargeException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { FirebaseStorageService } from '../../firebase/firebase-storage.service';
import { MediaType } from '../../generated/prisma/enums';
import type { UploadResponseDto } from './dto/upload-response.dto';
import { type DetectedMedia, detectMediaType } from './media-signature';
import type { UploadedMediaFile } from './uploaded-media-file';
import {
  UPLOAD_PURPOSE_RULES,
  type UploadPurpose,
  type UploadPurposeRule,
} from './uploads.constants';

export const UNSUPPORTED_TYPE_MESSAGE =
  'Unsupported file type. Allowed: JPEG, PNG or WebP images, MP4 or WebM videos';
export const AVATAR_TYPE_MESSAGE = 'Avatars must be a JPEG, PNG or WebP image';

const ONE_MB = 1024 * 1024;

/**
 * Validates uploaded media and stores it in Firebase Storage (FR-POST-02, FR-PROF-04,
 * NFR-SEC-07). The first step of the two-step upload (ADR-007): the returned `path` is
 * later attached to a post or profile.
 */
@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(private readonly storage: FirebaseStorageService) {}

  /**
   * Validates a file against the rules of its purpose and stores it at
   * `{posts|avatars}/{userId}/{uuid}.{ext}` with the detected content type.
   *
   * @param userId - Internal (PostgreSQL) ID of the uploader; namespaces the object path so
   *   ownership can be checked later from the path alone (ADR-007).
   * @param purpose - `post` (images and videos) or `avatar` (images only).
   * @param file - The uploaded bytes.
   * @returns The download URL, storage path, media type, content type and size.
   * @throws {BadRequestException} If the bytes are not an allowed format for the purpose.
   * @throws {PayloadTooLargeException} If the file exceeds the limit for its media type.
   * @throws {FirebaseUnavailableError} If Firebase Storage fails.
   */
  async upload(
    userId: string,
    purpose: UploadPurpose,
    file: UploadedMediaFile,
  ): Promise<UploadResponseDto> {
    const rule = UPLOAD_PURPOSE_RULES[purpose];
    const sizeBytes = file.buffer.length;
    const media = this.validate(rule, purpose, file.buffer);
    this.assertWithinSizeLimit(rule, media, sizeBytes);

    const path = `${rule.folder}/${userId}/${randomUUID()}.${media.extension}`;
    await this.storage.uploadObject({ path, data: file.buffer, contentType: media.contentType });
    const url = await this.getUrlOrCleanUp(path);

    // The path and size only: the URL contains the download token.
    this.logger.log(`Stored ${media.contentType} upload (${sizeBytes} bytes) at ${path}`);
    return { url, path, mediaType: media.mediaType, contentType: media.contentType, sizeBytes };
  }

  /** NFR-SEC-07: the type comes only from the magic bytes, never from the name or MIME type. */
  private validate(rule: UploadPurposeRule, purpose: UploadPurpose, bytes: Buffer): DetectedMedia {
    const media = detectMediaType(bytes);
    if (media === null) {
      throw new BadRequestException(UNSUPPORTED_TYPE_MESSAGE);
    }
    if (rule.maxBytes[media.mediaType] === undefined) {
      throw new BadRequestException(
        purpose === 'avatar' ? AVATAR_TYPE_MESSAGE : UNSUPPORTED_TYPE_MESSAGE,
      );
    }
    return media;
  }

  private assertWithinSizeLimit(
    rule: UploadPurposeRule,
    media: DetectedMedia,
    sizeBytes: number,
  ): void {
    const maxBytes = rule.maxBytes[media.mediaType] ?? 0;
    if (sizeBytes <= maxBytes) {
      return;
    }
    const kind = media.mediaType === MediaType.VIDEO ? 'Videos' : 'Images';
    throw new PayloadTooLargeException(`${kind} must be ${maxBytes / ONE_MB} MB or smaller`);
  }

  /**
   * Gets the download URL; if that fails, deletes the object just stored so a failed
   * request does not leave an orphaned file (ADR-007 consequences), then rethrows.
   */
  private async getUrlOrCleanUp(path: string): Promise<string> {
    try {
      return await this.storage.getDownloadUrl(path);
    } catch (error: unknown) {
      await this.storage.deleteObject(path).catch(() => {
        // Already logged by FirebaseStorageService; the original error matters more.
        this.logger.warn(`Could not delete ${path} after a failed upload; it is orphaned`);
      });
      throw error;
    }
  }
}
