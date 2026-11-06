import { ApiProperty } from '@nestjs/swagger';
import { CursorPageDto } from '../../../common/pagination/cursor-page.dto';
import type { CommentRow } from '../comment-query';
import { MAX_COMMENT_LENGTH } from '../posts.constants';
import { PostAuthorDto } from './post-response.dto';

/**
 * A comment on a post (FR-FEED-06). Built field by field, so internal columns such as
 * `authorId` never leak.
 */
export class CommentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  postId: string;

  @ApiProperty({ example: 'Great shot!', maxLength: MAX_COMMENT_LENGTH })
  body: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: PostAuthorDto })
  author: PostAuthorDto;

  /**
   * Maps a row selected with `commentSelect` to the response shape.
   *
   * @param row - The comment with its author.
   * @returns The response DTO.
   */
  static fromRow(this: void, row: CommentRow): CommentResponseDto {
    const author = new PostAuthorDto();
    author.id = row.author.id;
    author.username = row.author.username;
    author.displayName = row.author.displayName;
    author.avatarUrl = row.author.avatarUrl;

    const dto = new CommentResponseDto();
    dto.id = row.id;
    dto.postId = row.postId;
    dto.body = row.body;
    dto.createdAt = row.createdAt;
    dto.author = author;
    return dto;
  }
}

/** One page of comments (ADR-005). */
export class CommentPageDto extends CursorPageDto(CommentResponseDto) {}
