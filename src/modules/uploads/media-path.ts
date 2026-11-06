import { MEDIA_FORMATS, type MediaExtension } from './media-signature';

import { UPLOAD_PURPOSE_RULES, type UploadPurpose } from './uploads.constants';

/** The parts of a Storage path produced by POST /uploads. */
export interface ParsedMediaPath {
  /** Internal (PostgreSQL) ID of the user who uploaded the file. */
  ownerId: string;
  extension: MediaExtension;
}

/** Lowercase UUID, as written by `randomUUID()` and PostgreSQL's `gen_random_uuid()`. */
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** One anchored pattern per purpose: {folder}/{ownerId}/{uuid}.{allowed extension}. */
const PATH_PATTERNS: Readonly<Record<UploadPurpose, RegExp>> = {
  post: buildPathPattern('post'),
  avatar: buildPathPattern('avatar'),
};

/**
 * Parses a Storage path that a client claims came from POST /uploads (ADR-007). Only the
 * exact shape UploadsService produces is accepted, so traversal (`..`), extra segments,
 * other folders and extensions not allowed for the purpose all fail.
 *
 * @param path - The client-supplied path.
 * @param purpose - Which folder and extensions to accept.
 * @returns The owner ID and extension, or `null` if the path is malformed.
 */
export function parseMediaPath(path: string, purpose: UploadPurpose): ParsedMediaPath | null {
  const match = PATH_PATTERNS[purpose].exec(path);
  if (!match) {
    return null;
  }
  const [, ownerId, extension] = match;
  // The pattern only matches known extensions; the lookup narrows the type without a cast.
  const format = MEDIA_FORMATS.find((candidate) => candidate.extension === extension);
  return format ? { ownerId, extension: format.extension } : null;
}

function buildPathPattern(purpose: UploadPurpose): RegExp {
  const rule = UPLOAD_PURPOSE_RULES[purpose];
  const extensions = MEDIA_FORMATS.filter(
    (format) => rule.maxBytes[format.mediaType] !== undefined,
  ).map((format) => format.extension);
  return new RegExp(
    `^${rule.folder}/(${UUID_PATTERN})/${UUID_PATTERN}\\.(${extensions.join('|')})$`,
  );
}
