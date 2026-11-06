import { MediaType } from '../../generated/prisma/enums';

/**
 * File-type detection from magic bytes (NFR-SEC-07). The file name and the client's
 * declared MIME type are attacker-controlled, so the type of an upload is decided only by
 * its first bytes. Only the five formats FR-POST-02 allows are recognised; everything else,
 * including related formats such as HEIC, QuickTime or generic Matroska, returns `null`.
 */

/** MIME types an upload can have. */
export type MediaContentType =
  'image/jpeg' | 'image/png' | 'image/webp' | 'video/mp4' | 'video/webm';

/** File extension used in the stored object name. */
export type MediaExtension = 'jpg' | 'png' | 'webp' | 'mp4' | 'webm';

/** A recognised media format. */
export interface DetectedMedia {
  contentType: MediaContentType;
  mediaType: MediaType;
  extension: MediaExtension;
}

const JPEG: DetectedMedia = {
  contentType: 'image/jpeg',
  mediaType: MediaType.IMAGE,
  extension: 'jpg',
};
const PNG: DetectedMedia = {
  contentType: 'image/png',
  mediaType: MediaType.IMAGE,
  extension: 'png',
};
const WEBP: DetectedMedia = {
  contentType: 'image/webp',
  mediaType: MediaType.IMAGE,
  extension: 'webp',
};
const MP4: DetectedMedia = {
  contentType: 'video/mp4',
  mediaType: MediaType.VIDEO,
  extension: 'mp4',
};
const WEBM: DetectedMedia = {
  contentType: 'video/webm',
  mediaType: MediaType.VIDEO,
  extension: 'webm',
};

/** Every format an upload can have, e.g. to build allow-lists of extensions. */
export const MEDIA_FORMATS: readonly DetectedMedia[] = [JPEG, PNG, WEBP, MP4, WEBM];

/**
 * Looks up a format by the content type stored on a Storage object. Uploads store the
 * detected type (NFR-SEC-07), so this recovers the media type of an existing upload.
 *
 * @param contentType - A MIME type, e.g. from Storage object metadata.
 * @returns The format, or `null` if the type is missing or not an allowed format.
 */
export function mediaByContentType(contentType: string | undefined): DetectedMedia | null {
  return MEDIA_FORMATS.find((format) => format.contentType === contentType) ?? null;
}

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];
/** EBML DocType element ID, followed by a one-byte size (0x80 | length) and the type name. */
const EBML_DOCTYPE_ID = [0x42, 0x82];
/** The DocType element sits in the EBML header, well within the first 64 bytes. */
const EBML_HEADER_SCAN_BYTES = 64;

/**
 * ISO base media "major brands" that identify MP4. Other formats share the `ftyp` box
 * (HEIC `heic`, QuickTime `qt  `, 3GP `3gp4`), so the brand must be checked too.
 */
const MP4_BRANDS: ReadonlySet<string> = new Set([
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'avc1',
  'dash',
  'M4V ',
]);

/**
 * Detects the media format of a file from its first bytes.
 *
 * @param bytes - The file contents (only the first few dozen bytes are read).
 * @returns The format, or `null` if the bytes are not JPEG, PNG, WebP, MP4 or WebM,
 *   including when the input is too short to tell.
 */
export function detectMediaType(bytes: Buffer): DetectedMedia | null {
  if (startsWith(bytes, JPEG_MAGIC)) {
    return JPEG;
  }
  if (startsWith(bytes, PNG_MAGIC)) {
    return PNG;
  }
  if (isWebp(bytes)) {
    return WEBP;
  }
  if (isMp4(bytes)) {
    return MP4;
  }
  if (isWebm(bytes)) {
    return WEBM;
  }
  return null;
}

/** RIFF container ("RIFF", 4-byte size, "WEBP"); WAV and AVI are RIFF too. */
function isWebp(bytes: Buffer): boolean {
  return asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP');
}

/** ISO base media file: 4-byte box size, "ftyp", then a 4-byte major brand. */
function isMp4(bytes: Buffer): boolean {
  if (!asciiAt(bytes, 4, 'ftyp') || bytes.length < 12) {
    return false;
  }
  return MP4_BRANDS.has(bytes.toString('latin1', 8, 12));
}

/** EBML header whose DocType is "webm" (Matroska files have DocType "matroska"). */
function isWebm(bytes: Buffer): boolean {
  if (!startsWith(bytes, EBML_MAGIC)) {
    return false;
  }
  const header = bytes.subarray(0, EBML_HEADER_SCAN_BYTES);
  const docType = Buffer.from([...EBML_DOCTYPE_ID, 0x80 | 'webm'.length, ...Buffer.from('webm')]);
  return header.includes(docType);
}

function startsWith(bytes: Buffer, magic: readonly number[]): boolean {
  return bytes.length >= magic.length && magic.every((byte, index) => bytes[index] === byte);
}

function asciiAt(bytes: Buffer, offset: number, text: string): boolean {
  const end = offset + text.length;
  return bytes.length >= end && bytes.toString('latin1', offset, end) === text;
}
