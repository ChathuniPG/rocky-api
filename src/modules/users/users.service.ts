import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  type CursorPage,
  type CursorPosition,
  decodeCursor,
  keysetOrderBy,
  keysetWhere,
  toCursorPage,
} from '../../common/pagination/cursor-pagination';
import type { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import { FirebaseStorageService } from '../../firebase/firebase-storage.service';
import type { Prisma, User } from '../../generated/prisma/client';
import { MediaType } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { UserResponseDto } from '../auth/dto/user-response.dto';
import { PostResponseDto } from '../posts/dto/post-response.dto';
import { type PostRow, postSelect } from '../posts/post-query';
import { parseMediaPath } from '../uploads/media-path';
import { mediaByContentType } from '../uploads/media-signature';
import { ProfileResponseDto } from './dto/profile-response.dto';
import type { UpdateProfileDto } from './dto/update-profile.dto';
import { profileSelect } from './user-query';
import {
  AVATAR_NOT_FOUND,
  AVATAR_NOT_OWNED,
  EMPTY_PROFILE_UPDATE,
  INVALID_AVATAR_PATH,
  UNSUPPORTED_AVATAR,
  USER_NOT_FOUND,
} from './users.constants';

/** The avatar columns, written together so URL and path can never disagree. */
interface AvatarFields {
  avatarPath: string | null;
  avatarUrl: string | null;
}

/** A saved post, keyed for the cursor: saves have no id, so the post ID breaks ties. */
interface SavedPostRow extends CursorPosition {
  post: PostRow;
}

/**
 * Profiles, profile updates, and the posts and saved posts of a user (FR-PROF-01 to
 * FR-PROF-04, FR-SET-02, FR-SET-03).
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: FirebaseStorageService,
  ) {}

  /**
   * Returns a user's public profile with counts and the viewer's relation to it.
   *
   * @param viewerId - Internal ID of the signed-in user, for isFollowing and isMe.
   * @param username - The lowercase username.
   * @returns The profile.
   * @throws {NotFoundException} If no user has this username.
   */
  async getProfile(viewerId: string, username: string): Promise<ProfileResponseDto> {
    const row = await this.prisma.user.findUnique({
      where: { username },
      select: profileSelect(viewerId),
    });
    if (!row) {
      throw new NotFoundException(USER_NOT_FOUND);
    }
    return ProfileResponseDto.fromRow(row, viewerId);
  }

  /**
   * Updates the signed-in user's profile and settings. A new avatar is verified like a
   * post's media (ADR-007): the path must be in the user's own avatars folder, the object
   * must exist and be an image, and its URL is generated here. After the update, a
   * replaced or removed avatar object is deleted best-effort.
   *
   * @param user - The signed-in user's row, as loaded by the auth guard.
   * @param dto - Validated, trimmed fields; at least one must be present.
   * @returns The updated profile and settings, the same shape as GET /auth/me.
   * @throws {BadRequestException} If no field is present, or the avatar path is malformed,
   *   has no object, or the object is not a supported image.
   * @throws {ForbiddenException} If the avatar path is in another user's folder (NFR-SEC-02).
   * @throws {FirebaseUnavailableError} If Firebase Storage fails (503).
   */
  async updateProfile(user: User, dto: UpdateProfileDto): Promise<UserResponseDto> {
    if (Object.values(dto).every((value) => value === undefined)) {
      throw new BadRequestException(EMPTY_PROFILE_UPDATE);
    }
    const avatar = await this.resolveAvatarChange(user, dto.avatarPath);

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        displayName: dto.displayName,
        // An empty bio is stored as NULL, so "no bio" has a single representation.
        bio: dto.bio === '' ? null : dto.bio,
        notificationsEnabled: dto.notificationsEnabled,
        language: dto.language,
        ...avatar,
      },
    });
    this.logger.log(`User ${user.id} updated their profile`);

    // Row first, object second, as for posts: the reverse order could leave a profile
    // pointing at a deleted image. `user` was loaded by the guard for this request, so
    // its avatarPath is the one being replaced.
    if (avatar && user.avatarPath) {
      await this.deleteAvatarBestEffort(user.avatarPath);
    }
    return UserResponseDto.fromUser(updated);
  }

  /**
   * Returns one page of a user's posts, newest first (FR-PROF-02, ADR-005).
   *
   * @param viewerId - Internal ID of the signed-in user, for likedByMe / savedByMe.
   * @param username - The lowercase username.
   * @param query - Validated cursor and page size.
   * @returns The page and the cursor of the next one.
   * @throws {BadRequestException} If the cursor is invalid.
   * @throws {NotFoundException} If no user has this username.
   */
  async listUserPosts(
    viewerId: string,
    username: string,
    query: PaginationQueryDto,
  ): Promise<CursorPage<PostResponseDto>> {
    const position = decodeCursor(query.cursor);
    const authorId = await this.findUserIdByUsername(username);
    const rows = await this.prisma.post.findMany({
      // Served by the (author_id, created_at, id) index.
      where: { authorId, ...keysetWhere(position) },
      orderBy: keysetOrderBy(),
      take: query.limit + 1,
      select: postSelect(viewerId),
    });
    return toCursorPage(rows, query.limit, PostResponseDto.fromRow);
  }

  /**
   * Returns one page of the signed-in user's saved posts, most recently saved first
   * (FR-PROF-03, ADR-005). Only the owner can call this: the user comes from the session,
   * never from the URL.
   *
   * @param userId - Internal ID of the signed-in user.
   * @param query - Validated cursor and page size.
   * @returns The page and the cursor of the next one.
   * @throws {BadRequestException} If the cursor is invalid.
   */
  async listSavedPosts(
    userId: string,
    query: PaginationQueryDto,
  ): Promise<CursorPage<PostResponseDto>> {
    const position = decodeCursor(query.cursor);
    const saves = await this.prisma.save.findMany({
      // Served by the (user_id, created_at, post_id) index.
      where: { userId, ...savesAfter(position) },
      orderBy: [{ createdAt: 'desc' }, { postId: 'desc' }],
      take: query.limit + 1,
      select: { createdAt: true, postId: true, post: { select: postSelect(userId) } },
    });
    // The cursor holds the save's created_at and the post ID, so toCursorPage and
    // encodeCursor work unchanged.
    const rows = saves.map((save): SavedPostRow => ({
      createdAt: save.createdAt,
      id: save.postId,
      post: save.post,
    }));
    return toCursorPage(rows, query.limit, (row) => PostResponseDto.fromRow(row.post));
  }

  private async findUserIdByUsername(username: string): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { username }, select: { id: true } });
    if (!user) {
      throw new NotFoundException(USER_NOT_FOUND);
    }
    return user.id;
  }

  /**
   * Decides the avatar columns to write. Returns `undefined` when the avatar does not
   * change: the field is absent, or it repeats the current value. Re-sending the current
   * path must not be treated as a replacement, or the live avatar would be deleted.
   */
  private async resolveAvatarChange(
    user: User,
    avatarPath: string | null | undefined,
  ): Promise<AvatarFields | undefined> {
    if (avatarPath === undefined || avatarPath === user.avatarPath) {
      return undefined;
    }
    if (avatarPath === null) {
      return { avatarPath: null, avatarUrl: null };
    }
    this.assertOwnAvatarPath(user.id, avatarPath);
    return { avatarPath, avatarUrl: await this.verifyStoredAvatar(avatarPath) };
  }

  /**
   * ADR-007: ownership comes from the path alone, because UploadsService writes every
   * object under its uploader's ID. Malformed input is a 400; someone else's folder a 403.
   */
  private assertOwnAvatarPath(userId: string, avatarPath: string): void {
    const parsed = parseMediaPath(avatarPath, 'avatar');
    if (!parsed) {
      throw new BadRequestException(INVALID_AVATAR_PATH);
    }
    if (parsed.ownerId !== userId) {
      throw new ForbiddenException(AVATAR_NOT_OWNED);
    }
  }

  /**
   * Reads the object's metadata instead of trusting the client. Its content type was set
   * from the file's magic bytes on upload (NFR-SEC-07).
   *
   * @returns The download URL, generated server-side.
   */
  private async verifyStoredAvatar(path: string): Promise<string> {
    const metadata = await this.storage.getObjectMetadata(path);
    if (!metadata.exists) {
      throw new BadRequestException(AVATAR_NOT_FOUND);
    }
    const format = mediaByContentType(metadata.contentType);
    if (format?.mediaType !== MediaType.IMAGE || !path.endsWith(`.${format.extension}`)) {
      throw new BadRequestException(UNSUPPORTED_AVATAR);
    }
    return this.storage.getDownloadUrl(path);
  }

  private async deleteAvatarBestEffort(path: string): Promise<void> {
    try {
      await this.storage.deleteObject(path);
    } catch {
      // The profile already shows the new avatar; a leftover object only costs storage.
      // FirebaseStorageService logged the error code; this names the orphan (ADR-007).
      this.logger.warn(`Could not delete replaced avatar ${path}; it is orphaned`);
    }
  }
}

/**
 * Keyset condition for saves, ordered by (created_at DESC, post_id DESC): the same
 * condition as `keysetWhere`, with post_id as the tie-breaker because saves have no id.
 */
function savesAfter(position: CursorPosition | undefined): Prisma.SaveWhereInput {
  if (!position) {
    return {};
  }
  return {
    OR: [
      { createdAt: { lt: position.createdAt } },
      { createdAt: position.createdAt, postId: { lt: position.id } },
    ],
  };
}
