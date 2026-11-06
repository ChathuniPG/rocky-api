import { Controller, Get, HttpCode, HttpStatus, Param, Patch, Query } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ID_TOKEN_COOKIE } from '../../common/auth/auth-cookies';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator';
import type { User } from '../../generated/prisma/client';
import { NotificationIdParamDto } from './dto/notification-id-param.dto';
import { NotificationPageDto } from './dto/notification-response.dto';
import { UnreadCountDto } from './dto/unread-count.dto';
import { NotificationsService } from './notifications.service';

/** Errors every notification endpoint can return: auth, rate limit and backing-service outages. */
const COMMON_ERRORS = [
  HttpStatus.UNAUTHORIZED,
  HttpStatus.FORBIDDEN,
  HttpStatus.TOO_MANY_REQUESTS,
  HttpStatus.SERVICE_UNAVAILABLE,
] as const;

/**
 * Notification endpoints (design §5.2). Every route requires authentication and only
 * ever reads or changes the signed-in user's own notifications.
 */
@ApiTags('Notifications')
@ApiCookieAuth(ID_TOKEN_COOKIE)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** The user's notifications, newest first (FR-NOTF-02). */
  @Get()
  @ApiOperation({
    summary: 'Your notifications, newest first (cursor-paginated)',
    description: 'Pass `nextCursor` from a page as `cursor` to get the next one (ADR-005).',
  })
  @ApiOkResponse({ type: NotificationPageDto })
  @ApiErrorResponses(
    { status: HttpStatus.BAD_REQUEST, description: 'Invalid cursor or limit.' },
    ...COMMON_ERRORS,
  )
  list(
    @Query() query: PaginationQueryDto,
    @CurrentUser() user: User,
  ): Promise<NotificationPageDto> {
    return this.notifications.list(user.id, query);
  }

  /** Unread count for the navigation badge (FR-NOTF-04). */
  @Get('unread-count')
  @ApiOperation({ summary: 'Number of your unread notifications' })
  @ApiOkResponse({ type: UnreadCountDto })
  @ApiErrorResponses(...COMMON_ERRORS)
  unreadCount(@CurrentUser() user: User): Promise<UnreadCountDto> {
    return this.notifications.countUnread(user.id);
  }

  /** Marks all of the user's notifications as read (FR-NOTF-03). */
  @Patch('read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mark all your notifications as read' })
  @ApiNoContentResponse({ description: 'All notifications are read.' })
  @ApiErrorResponses(...COMMON_ERRORS)
  markAllRead(@CurrentUser() user: User): Promise<void> {
    return this.notifications.markAllRead(user.id);
  }

  /** Marks one of the user's notifications as read (FR-NOTF-03). */
  @Patch(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Mark one of your notifications as read',
    description: 'Idempotent. Another user’s notification is reported as 404 (NFR-SEC-02).',
  })
  @ApiNoContentResponse({ description: 'The notification is read.' })
  @ApiErrorResponses(
    { status: HttpStatus.BAD_REQUEST, description: 'The ID is not a UUID.' },
    { status: HttpStatus.NOT_FOUND, description: 'You have no notification with this ID.' },
    ...COMMON_ERRORS,
  )
  markRead(@Param() params: NotificationIdParamDto, @CurrentUser() user: User): Promise<void> {
    return this.notifications.markRead(user.id, params.id);
  }
}
