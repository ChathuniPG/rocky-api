import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  type CursorPage,
  decodeCursor,
  keysetOrderBy,
  keysetWhere,
  toCursorPage,
} from '../../common/pagination/cursor-pagination';
import type { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import { FirebaseStorageService } from '../../firebase/firebase-storage.service';
import type { MediaType } from '../../generated/prisma/enums';
import { isUniqueConstraintViolation } from '../../prisma/prisma-errors';
import { PrismaService } from '../../prisma/prisma.service';
import { parseMediaPath } from '../uploads/media-path';
import { mediaByContentType } from '../uploads/media-signature';
import type { CreatePostDto } from './dto/create-post.dto';
import { PostResponseDto } from './dto/post-response.dto';
import type { UpdatePostDto } from './dto/update-post.dto';
import { postSelect } from './post-query';
import {
  INVALID_MEDIA_PATH,
  MEDIA_ALREADY_USED,
  MEDIA_NOT_FOUND,
  MEDIA_NOT_OWNED,
  NOT_POST_OWNER,
  POST_NOT_FOUND,
  UNSUPPORTED_MEDIA,
} from './posts.constants';

/** Verified facts about an uploaded media object, read from Storage. */
interface VerifiedMedia {
  path: string;
  url: string;
  mediaType: MediaType;
}

/**
 * Posts and the home feed (FR-POST-01, FR-POST-06, FR-FEED-01, FR-FEED-02). Creating a
 * post is the second step of the two-step upload (ADR-007): the client sends the path
 * returned by POST /uploads, and nothing else about the file is taken from the client.
 */
@Injectable()
export class PostsService {
  private readonly logger = new Logger(PostsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: FirebaseStorageService,
  ) {}

  /**
   * Creates a post from a previously uploaded media file. The path must have the exact
   * shape POST /uploads produces and be in the caller's own folder; the object must
   * exist; its media type comes from the stored content type and its URL is generated
   * here.
   *
   * @param authorId - Internal ID of the signed-in user.
   * @param dto - Validated caption and media path.
   * @returns The new post, as the author sees it.
   * @throws {BadRequestException} If the path is malformed, no object exists there, or
   *   the object's content type is not an allowed media type.
   * @throws {ForbiddenException} If the path is in another user's folder (NFR-SEC-02).
   * @throws {ConflictException} If another post already uses the path.
   * @throws {FirebaseUnavailableError} If Firebase Storage fails (503).
   */
  async create(authorId: string, dto: CreatePostDto): Promise<PostResponseDto> {
    this.assertOwnMediaPath(authorId, dto.mediaPath);
    await this.assertMediaPathUnused(dto.mediaPath);
    const media = await this.verifyStoredMedia(dto.mediaPath);

    try {
      const row = await this.prisma.post.create({
        data: {
          authorId,
          caption: dto.caption,
          mediaPath: media.path,
          mediaUrl: media.url,
          mediaType: media.mediaType,
        },
        select: postSelect(authorId),
      });
      this.logger.log(`User ${authorId} created post ${row.id}`);
      return PostResponseDto.fromRow(row);
    } catch (error: unknown) {
      // A concurrent request attached the same upload between the check and the insert;
      // the unique index on media_path decides the winner.
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictException(MEDIA_ALREADY_USED);
      }
      throw error;
    }
  }

  /**
   * Returns one page of the home feed: every post, newest first (ADR-005).
   *
   * @param viewerId - Internal ID of the signed-in user, for likedByMe / savedByMe.
   * @param query - Validated cursor and page size.
   * @returns The page and the cursor of the next one.
   * @throws {BadRequestException} If the cursor is invalid.
   */
  async getFeed(viewerId: string, query: PaginationQueryDto): Promise<CursorPage<PostResponseDto>> {
    const position = decodeCursor(query.cursor);
    const rows = await this.prisma.post.findMany({
      where: keysetWhere(position),
      orderBy: keysetOrderBy(),
      // One extra row tells whether a next page exists (see toCursorPage).
      take: query.limit + 1,
      select: postSelect(viewerId),
    });
    return toCursorPage(rows, query.limit, PostResponseDto.fromRow);
  }

  /**
   * Returns a single post (FR-POST-06).
   *
   * @param viewerId - Internal ID of the signed-in user, for likedByMe / savedByMe.
   * @param postId - The post's ID.
   * @returns The post.
   * @throws {NotFoundException} If no post has this ID.
   */
  async findById(viewerId: string, postId: string): Promise<PostResponseDto> {
    const row = await this.prisma.post.findUnique({
      where: { id: postId },
      select: postSelect(viewerId),
    });
    if (!row) {
      throw new NotFoundException(POST_NOT_FOUND);
    }
    return PostResponseDto.fromRow(row);
  }

  /**
   * Replaces a post's caption (FR-POST-04).
   *
   * @param viewerId - Internal ID of the signed-in user; must be the author.
   * @param postId - The post's ID.
   * @param dto - The validated, trimmed caption.
   * @returns The updated post.
   * @throws {NotFoundException} If no post has this ID.
   * @throws {ForbiddenException} If the user is not the author (NFR-SEC-02).
   */
  async updateCaption(
    viewerId: string,
    postId: string,
    dto: UpdatePostDto,
  ): Promise<PostResponseDto> {
    await this.findOwnedPost(viewerId, postId);
    // A post deleted between the check and the update raises P2025, which the global
    // exception filter turns into 404.
    const row = await this.prisma.post.update({
      where: { id: postId },
      data: { caption: dto.caption },
      select: postSelect(viewerId),
    });
    return PostResponseDto.fromRow(row);
  }

  /**
   * Deletes a post (FR-POST-05), then its media object. Likes, saves, comments and
   * notifications of the post are removed by ON DELETE CASCADE in the same statement.
   * The Storage delete is best-effort: once the row is gone the post no longer exists
   * for anyone, so a Storage failure is logged rather than failing the request.
   *
   * @param viewerId - Internal ID of the signed-in user; must be the author.
   * @param postId - The post's ID.
   * @throws {NotFoundException} If no post has this ID.
   * @throws {ForbiddenException} If the user is not the author (NFR-SEC-02).
   */
  async delete(viewerId: string, postId: string): Promise<void> {
    const { mediaPath } = await this.findOwnedPost(viewerId, postId);
    // Row first, object second: the reverse order could leave a visible post whose media
    // is gone. The unique media_path guarantees no other post uses this object.
    await this.prisma.post.delete({ where: { id: postId } });
    this.logger.log(`User ${viewerId} deleted post ${postId}`);
    await this.deleteMediaBestEffort(mediaPath);
  }

  /** Loads the fields needed for an ownership check; 404 before 403. */
  private async findOwnedPost(
    viewerId: string,
    postId: string,
  ): Promise<{ authorId: string; mediaPath: string }> {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { authorId: true, mediaPath: true },
    });
    if (!post) {
      throw new NotFoundException(POST_NOT_FOUND);
    }
    if (post.authorId !== viewerId) {
      throw new ForbiddenException(NOT_POST_OWNER);
    }
    return post;
  }

  private async deleteMediaBestEffort(mediaPath: string): Promise<void> {
    try {
      await this.storage.deleteObject(mediaPath);
    } catch {
      // FirebaseStorageService already logged the error code; this names the orphan so it
      // can be removed by hand or by the future cleanup job (ADR-007).
      this.logger.warn(`Could not delete media ${mediaPath} of a deleted post; it is orphaned`);
    }
  }

  /**
   * ADR-007: ownership is decided from the path alone, because UploadsService writes
   * every object under its uploader's ID. Malformed input is a 400; a well-formed path
   * in someone else's folder is a 403.
   */
  private assertOwnMediaPath(userId: string, mediaPath: string): void {
    const parsed = parseMediaPath(mediaPath, 'post');
    if (!parsed) {
      throw new BadRequestException(INVALID_MEDIA_PATH);
    }
    if (parsed.ownerId !== userId) {
      throw new ForbiddenException(MEDIA_NOT_OWNED);
    }
  }

  /** Checked before Storage: cheaper, and gives the clearer error for a reused upload. */
  private async assertMediaPathUnused(mediaPath: string): Promise<void> {
    const existing = await this.prisma.post.findUnique({
      where: { mediaPath },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(MEDIA_ALREADY_USED);
    }
  }

  /**
   * Reads the object's metadata instead of trusting the client about the file. The
   * content type was set by UploadsService from the file's magic bytes (NFR-SEC-07).
   */
  private async verifyStoredMedia(path: string): Promise<VerifiedMedia> {
    const metadata = await this.storage.getObjectMetadata(path);
    if (!metadata.exists) {
      throw new BadRequestException(MEDIA_NOT_FOUND);
    }
    const format = mediaByContentType(metadata.contentType);
    // The extension check catches an object whose path and stored type disagree, which
    // POST /uploads never produces.
    if (!format || !path.endsWith(`.${format.extension}`)) {
      throw new BadRequestException(UNSUPPORTED_MEDIA);
    }
    const url = await this.storage.getDownloadUrl(path);
    return { path, url, mediaType: format.mediaType };
  }
}
