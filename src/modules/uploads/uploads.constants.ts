import { MediaType } from '../../generated/prisma/enums';

/**
 * Upload policy (FR-POST-02, FR-PROF-04, NFR-SEC-07). Code constants, not environment
 * variables: like the rate limits, they are product rules that must be the same in every
 * environment.
 */

const ONE_MB = 1024 * 1024;

/** Largest image of any purpose: 5 MB (FR-POST-02). */
export const MAX_IMAGE_BYTES = 5 * ONE_MB;

/** Largest video, and therefore the largest upload the parser accepts: 25 MB (FR-POST-02). */
export const MAX_VIDEO_BYTES = 25 * ONE_MB;

/** What an upload is for; decides the allowed media types and the storage folder. */
export const UPLOAD_PURPOSES = ['avatar', 'post'] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];

/** Rules for one purpose. */
export interface UploadPurposeRule {
  /** Top-level folder in the bucket (ADR-007): {folder}/{userId}/{uuid}.{ext}. */
  folder: string;
  /** Maximum size per allowed media type; a missing type is not allowed. */
  maxBytes: Readonly<Partial<Record<MediaType, number>>>;
}

export const UPLOAD_PURPOSE_RULES: Readonly<Record<UploadPurpose, UploadPurposeRule>> = {
  post: {
    folder: 'posts',
    maxBytes: { [MediaType.IMAGE]: MAX_IMAGE_BYTES, [MediaType.VIDEO]: MAX_VIDEO_BYTES },
  },
  // FR-PROF-04: avatars are images only.
  avatar: { folder: 'avatars', maxBytes: { [MediaType.IMAGE]: MAX_IMAGE_BYTES } },
};

/**
 * Multipart parser limits. The parser stops reading at `fileSize`, so an oversized body is
 * never fully buffered in memory; the per-type limits are then checked by UploadsService.
 * The field limits only leave room for `purpose`.
 */
export const MULTIPART_LIMITS = {
  files: 1,
  fileSize: MAX_VIDEO_BYTES,
  fields: 1,
  fieldNameSize: 32,
  fieldSize: 64,
  parts: 2,
} as const;
