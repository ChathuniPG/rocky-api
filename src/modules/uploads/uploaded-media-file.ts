/**
 * The part of a multer in-memory file that the uploads module uses: only the bytes. The
 * client's file name and declared MIME type are left out on purpose: they are untrusted,
 * and the type and size are taken from the bytes themselves (NFR-SEC-07). Declared locally
 * instead of adding `@types/multer`, which would only be needed for this type.
 */
export interface UploadedMediaFile {
  /** The complete file contents (memory storage). */
  buffer: Buffer;
}
