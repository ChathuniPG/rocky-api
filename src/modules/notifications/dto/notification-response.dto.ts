import { ApiProperty } from '@nestjs/swagger';
import { CursorPageDto } from '../../../common/pagination/cursor-page.dto';
import { MediaType, NotificationType } from '../../../generated/prisma/enums';
import { PostAuthorDto } from '../../posts/dto/post-response.dto';
import type { NotificationRow } from '../notification-query';

/** The post a LIKE or COMMENT notification is about: enough for a thumbnail and a link. */
export class NotificationPostDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uri', description: 'Long-lived Firebase download URL.' })
  mediaUrl: string;

  @ApiProperty({ enum: MediaType, enumName: 'MediaType', example: MediaType.IMAGE })
  mediaType: MediaType;
}

/** The comment a COMMENT notification is about. */
export class NotificationCommentDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Great shot!' })
  body: string;
}

/**
 * One notification (FR-NOTF-02). Built field by field, so internal columns such as
 * `recipientId` never leak.
 */
export class NotificationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    enum: NotificationType,
    enumName: 'NotificationType',
    example: NotificationType.LIKE,
  })
  type: NotificationType;

  @ApiProperty({ example: false })
  isRead: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: PostAuthorDto, description: 'The user who liked, commented or followed.' })
  actor: PostAuthorDto;

  @ApiProperty({
    type: NotificationPostDto,
    nullable: true,
    description: 'Set for LIKE and COMMENT, null for FOLLOW.',
  })
  post: NotificationPostDto | null;

  @ApiProperty({
    type: NotificationCommentDto,
    nullable: true,
    description: 'Set for COMMENT only.',
  })
  comment: NotificationCommentDto | null;

  /**
   * Maps a row selected with `notificationSelect` to the response shape.
   *
   * @param row - The notification with its actor, post and comment.
   * @returns The response DTO.
   */
  static fromRow(this: void, row: NotificationRow): NotificationResponseDto {
    const actor = new PostAuthorDto();
    actor.id = row.actor.id;
    actor.username = row.actor.username;
    actor.displayName = row.actor.displayName;
    actor.avatarUrl = row.actor.avatarUrl;

    const dto = new NotificationResponseDto();
    dto.id = row.id;
    dto.type = row.type;
    dto.isRead = row.isRead;
    dto.createdAt = row.createdAt;
    dto.actor = actor;
    dto.post = row.post ? toPostDto(row.post) : null;
    dto.comment = row.comment ? toCommentDto(row.comment) : null;
    return dto;
  }
}

/** One page of notifications (ADR-005). */
export class NotificationPageDto extends CursorPageDto(NotificationResponseDto) {}

function toPostDto(post: NonNullable<NotificationRow['post']>): NotificationPostDto {
  const dto = new NotificationPostDto();
  dto.id = post.id;
  dto.mediaUrl = post.mediaUrl;
  dto.mediaType = post.mediaType;
  return dto;
}

function toCommentDto(comment: NonNullable<NotificationRow['comment']>): NotificationCommentDto {
  const dto = new NotificationCommentDto();
  dto.id = comment.id;
  dto.body = comment.body;
  return dto;
}
