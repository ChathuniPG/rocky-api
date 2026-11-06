import { ApiProperty } from '@nestjs/swagger';
import { CursorPageDto } from '../../../common/pagination/cursor-page.dto';
import { MediaType } from '../../../generated/prisma/enums';
import type { PostRow } from '../post-query';

/** The public fields of a post's author (FR-FEED-02). */
export class PostAuthorDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'alice' })
  username: string;

  @ApiProperty({ example: 'Alice' })
  displayName: string;

  @ApiProperty({ type: String, format: 'uri', nullable: true, example: null })
  avatarUrl: string | null;
}

/**
 * A post as shown in the feed and on its own page (FR-FEED-02, FR-POST-06). Built field
 * by field, so internal columns such as `mediaPath` and `authorId` never leak.
 */
export class PostResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Sunset at the beach', maxLength: 2200 })
  caption: string;

  @ApiProperty({ format: 'uri', description: 'Long-lived Firebase download URL.' })
  mediaUrl: string;

  @ApiProperty({ enum: MediaType, enumName: 'MediaType', example: MediaType.IMAGE })
  mediaType: MediaType;

  @ApiProperty({ example: 12 })
  likeCount: number;

  @ApiProperty({ example: 3 })
  commentCount: number;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  @ApiProperty({ type: PostAuthorDto })
  author: PostAuthorDto;

  @ApiProperty({ description: 'Whether the signed-in user has liked the post.' })
  likedByMe: boolean;

  @ApiProperty({ description: 'Whether the signed-in user has saved the post.' })
  savedByMe: boolean;

  /**
   * Maps a row selected with `postSelect` to the response shape.
   *
   * @param row - The post with its author and the viewer's like/save counts.
   * @returns The response DTO.
   */
  static fromRow(this: void, row: PostRow): PostResponseDto {
    // `_count` is Prisma's name for relation counts.
    const { _count: viewerCounts } = row;
    const author = new PostAuthorDto();
    author.id = row.author.id;
    author.username = row.author.username;
    author.displayName = row.author.displayName;
    author.avatarUrl = row.author.avatarUrl;

    const dto = new PostResponseDto();
    dto.id = row.id;
    dto.caption = row.caption;
    dto.mediaUrl = row.mediaUrl;
    dto.mediaType = row.mediaType;
    dto.likeCount = row.likeCount;
    dto.commentCount = row.commentCount;
    dto.createdAt = row.createdAt;
    dto.updatedAt = row.updatedAt;
    dto.author = author;
    // The counts are filtered to the viewer, so they are 0 or 1.
    dto.likedByMe = viewerCounts.likes > 0;
    dto.savedByMe = viewerCounts.saves > 0;
    return dto;
  }
}

/** One page of posts (ADR-005). */
export class PostPageDto extends CursorPageDto(PostResponseDto) {}
