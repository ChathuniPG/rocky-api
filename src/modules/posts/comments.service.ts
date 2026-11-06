import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  type CursorPage,
  decodeCursor,
  keysetOrderBy,
  keysetWhere,
  toCursorPage,
} from '../../common/pagination/cursor-pagination';
import type { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import { NotificationType } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { commentSelect } from './comment-query';
import { CommentResponseDto } from './dto/comment-response.dto';
import type { CreateCommentDto } from './dto/create-comment.dto';
import { assertPostExists } from './post-existence';
import { COMMENT_NOT_FOUND, NOT_COMMENT_AUTHOR } from './posts.constants';

/**
 * Comments on posts (FR-FEED-06). posts.comment_count is denormalised (ADR-006) and is
 * changed in the same transaction as the comment row it counts, as is the post author's
 * COMMENT notification (FR-NOTF-01). Deleting a comment cascades to its notification.
 */
@Injectable()
export class CommentsService {
  private readonly logger = new Logger(CommentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Returns one page of a post's comments, newest first (ADR-005).
   *
   * @param postId - The post's ID.
   * @param query - Validated cursor and page size.
   * @returns The page and the cursor of the next one.
   * @throws {BadRequestException} If the cursor is invalid.
   * @throws {NotFoundException} If no post has this ID.
   */
  async list(postId: string, query: PaginationQueryDto): Promise<CursorPage<CommentResponseDto>> {
    const position = decodeCursor(query.cursor);
    // Without this check, a missing post would look like a post with no comments.
    await assertPostExists(this.prisma, postId);
    const rows = await this.prisma.comment.findMany({
      // Served by the (post_id, created_at, id) index.
      where: { postId, ...keysetWhere(position) },
      orderBy: keysetOrderBy(),
      // One extra row tells whether a next page exists (see toCursorPage).
      take: query.limit + 1,
      select: commentSelect,
    });
    return toCursorPage(rows, query.limit, CommentResponseDto.fromRow);
  }

  /**
   * Adds a comment to a post, increments its comment count and notifies the post author,
   * in one transaction.
   *
   * @param authorId - Internal ID of the signed-in user.
   * @param postId - The post's ID.
   * @param dto - The validated, trimmed body.
   * @returns The new comment.
   * @throws {NotFoundException} If no post has this ID.
   */
  async create(
    authorId: string,
    postId: string,
    dto: CreateCommentDto,
  ): Promise<CommentResponseDto> {
    const row = await this.prisma.$transaction(async (tx) => {
      await assertPostExists(tx, postId);
      // A post deleted after the check makes the insert fail its foreign key (P2003),
      // which the global exception filter reports as 404.
      const comment = await tx.comment.create({
        data: { postId, authorId, body: dto.body },
        select: commentSelect,
      });
      // ADR-006: counter updated atomically in the same transaction as the comment. The
      // same statement returns the author, the notification's recipient.
      const post = await tx.post.update({
        where: { id: postId },
        data: { commentCount: { increment: 1 } },
        select: { authorId: true },
      });
      await this.notifications.create(tx, {
        type: NotificationType.COMMENT,
        actorId: authorId,
        recipientId: post.authorId,
        postId,
        commentId: comment.id,
      });
      return comment;
    });
    this.logger.log(`User ${authorId} commented ${row.id} on post ${postId}`);
    return CommentResponseDto.fromRow(row);
  }

  /**
   * Deletes the user's own comment and decrements its post's comment count, in one
   * transaction.
   *
   * @param userId - Internal ID of the signed-in user; must be the comment's author.
   * @param commentId - The comment's ID.
   * @throws {NotFoundException} If no comment has this ID.
   * @throws {ForbiddenException} If the user is not the comment's author (NFR-SEC-02).
   */
  async delete(userId: string, commentId: string): Promise<void> {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
      select: { authorId: true, postId: true },
    });
    // 404 before 403, as for posts.
    if (!comment) {
      throw new NotFoundException(COMMENT_NOT_FOUND);
    }
    if (comment.authorId !== userId) {
      throw new ForbiddenException(NOT_COMMENT_AUTHOR);
    }

    await this.prisma.$transaction(async (tx) => {
      // deleteMany reports whether this call removed the row. Two concurrent deletes of
      // the same comment both pass the check above, but only one decrements.
      const { count } = await tx.comment.deleteMany({ where: { id: commentId } });
      if (count === 0) {
        return;
      }
      // updateMany rather than update: if the post itself was deleted concurrently there
      // is no counter left to fix, and that is not an error.
      await tx.post.updateMany({
        where: { id: comment.postId },
        data: { commentCount: { decrement: 1 } },
      });
    });
    this.logger.log(`User ${userId} deleted comment ${commentId}`);
  }
}
