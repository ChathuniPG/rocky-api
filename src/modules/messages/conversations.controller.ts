import { Body, Controller, Get, HttpStatus, Post, Query, Res } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ID_TOKEN_COOKIE } from '../../common/auth/auth-cookies';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator';
import type { User } from '../../generated/prisma/client';
import { ConversationsService } from './conversations.service';
import { ConversationPageDto, ConversationResponseDto } from './dto/conversation-response.dto';
import { CreateConversationDto } from './dto/create-conversation.dto';

/** Errors every conversation endpoint can return: auth, rate limit and backing-service outages. */
export const CONVERSATION_COMMON_ERRORS = [
  HttpStatus.UNAUTHORIZED,
  HttpStatus.FORBIDDEN,
  HttpStatus.TOO_MANY_REQUESTS,
  HttpStatus.SERVICE_UNAVAILABLE,
] as const;

/**
 * Conversation endpoints (design §5.2). Every route requires authentication and only
 * ever returns conversations the signed-in user takes part in.
 */
@ApiTags('Messages')
@ApiCookieAuth(ID_TOKEN_COOKIE)
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  /** The user's conversations, latest activity first (FR-MSG-01, FR-MSG-05). */
  @Get()
  @ApiOperation({
    summary: 'Your conversations, latest activity first (cursor-paginated)',
    description:
      'Each item has the other participant, the last message and your unread count. ' +
      'Pass `nextCursor` from a page as `cursor` to get the next one (ADR-005).',
  })
  @ApiOkResponse({ type: ConversationPageDto })
  @ApiErrorResponses(
    { status: HttpStatus.BAD_REQUEST, description: 'Invalid cursor or limit.' },
    ...CONVERSATION_COMMON_ERRORS,
  )
  list(
    @Query() query: PaginationQueryDto,
    @CurrentUser() user: User,
  ): Promise<ConversationPageDto> {
    return this.conversations.list(user.id, query);
  }

  /** Opens the conversation with another user, creating it if needed (FR-PROF-06). */
  @Post()
  @ApiOperation({
    summary: 'Open your conversation with a user (get or create)',
    description: 'Returns 201 when the conversation is created and 200 when it already exists.',
  })
  @ApiCreatedResponse({ type: ConversationResponseDto, description: 'A new conversation.' })
  @ApiOkResponse({ type: ConversationResponseDto, description: 'The existing conversation.' })
  @ApiErrorResponses(
    {
      status: HttpStatus.BAD_REQUEST,
      description: 'recipientId is not a UUID, or is your own ID.',
    },
    { status: HttpStatus.NOT_FOUND, description: 'No user has this ID.' },
    ...CONVERSATION_COMMON_ERRORS,
  )
  async open(
    @Body() dto: CreateConversationDto,
    @CurrentUser() user: User,
    // passthrough keeps Nest's normal response handling; only the status is set here,
    // like returning ResponseEntity.status(...) in Spring.
    @Res({ passthrough: true }) response: Response,
  ): Promise<ConversationResponseDto> {
    const { conversation, created } = await this.conversations.open(user.id, dto.recipientId);
    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return conversation;
  }
}
