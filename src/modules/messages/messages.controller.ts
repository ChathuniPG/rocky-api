import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ID_TOKEN_COOKIE } from '../../common/auth/auth-cookies';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator';
import { DEFAULT_THROTTLER, MESSAGE_THROTTLE } from '../../common/throttling/throttling.constants';
import type { User } from '../../generated/prisma/client';
import { ConversationIdParamDto } from './dto/conversation-id-param.dto';
import { CreateMessageDto } from './dto/create-message.dto';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto';
import { MessagePageDto, MessageResponseDto } from './dto/message-response.dto';
import { CONVERSATION_COMMON_ERRORS, MAX_MESSAGE_LENGTH } from './messages.constants';
import { MessagesService } from './messages.service';

const NOT_A_PARTICIPANT = {
  status: HttpStatus.NOT_FOUND,
  description: 'You have no conversation with this ID (also for conversations of other users).',
};

/**
 * Message endpoints nested under /conversations/:id (design §5.2). Every route requires
 * authentication and is limited to the conversation's two participants.
 */
@ApiTags('Messages')
@ApiCookieAuth(ID_TOKEN_COOKIE)
@Controller('conversations')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  /** A conversation's messages: history, or new messages for polling (FR-MSG-02, FR-MSG-04). */
  @Get(':id/messages')
  @ApiOperation({
    summary: "A conversation's messages (history or polling)",
    description:
      'Without `after`: history, newest first; pass `nextCursor` as `cursor` for older ' +
      'messages (ADR-005). With `after`: messages strictly newer than that message, ' +
      'oldest first, up to `limit`, `nextCursor` always null (polling, ADR-008).',
  })
  @ApiOkResponse({ type: MessagePageDto })
  @ApiErrorResponses(
    {
      status: HttpStatus.BAD_REQUEST,
      description:
        'Invalid ID, cursor, limit or after; cursor and after together; or after is not a ' +
        'message of this conversation.',
    },
    NOT_A_PARTICIPANT,
    ...CONVERSATION_COMMON_ERRORS,
  )
  list(
    @Param() params: ConversationIdParamDto,
    @Query() query: ListMessagesQueryDto,
    @CurrentUser() user: User,
  ): Promise<MessagePageDto> {
    return this.messages.list(user.id, params.id, query);
  }

  /** Sends a message (FR-MSG-03). */
  @Post(':id/messages')
  // Stricter than the global default; per client IP (ADR-012).
  @Throttle({ [DEFAULT_THROTTLER]: MESSAGE_THROTTLE })
  @ApiOperation({
    summary: 'Send a message',
    description: `Rate limited to ${MESSAGE_THROTTLE.limit} messages per minute.`,
  })
  @ApiCreatedResponse({ type: MessageResponseDto, description: 'The message was sent.' })
  @ApiErrorResponses(
    {
      status: HttpStatus.BAD_REQUEST,
      description: `Invalid ID, or the body is blank or longer than ${MAX_MESSAGE_LENGTH} characters.`,
    },
    NOT_A_PARTICIPANT,
    ...CONVERSATION_COMMON_ERRORS,
  )
  send(
    @Param() params: ConversationIdParamDto,
    @Body() dto: CreateMessageDto,
    @CurrentUser() user: User,
  ): Promise<MessageResponseDto> {
    return this.messages.send(user.id, params.id, dto);
  }

  /** Marks the other participant's messages as read (FR-MSG-05). */
  @Patch(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Mark the conversation as read',
    description: "Sets readAt on the other participant's unread messages. Idempotent.",
  })
  @ApiNoContentResponse({ description: 'The conversation is read.' })
  @ApiErrorResponses(
    { status: HttpStatus.BAD_REQUEST, description: 'The ID is not a UUID.' },
    NOT_A_PARTICIPANT,
    ...CONVERSATION_COMMON_ERRORS,
  )
  markRead(@Param() params: ConversationIdParamDto, @CurrentUser() user: User): Promise<void> {
    return this.messages.markRead(user.id, params.id);
  }
}
