import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import { ID_TOKEN_COOKIE } from '../../common/auth/auth-cookies';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator';
import type { User } from '../../generated/prisma/client';
import { CommentsService } from './comments.service';
import { CommentIdParamDto } from './dto/comment-id-param.dto';
import { CommentPageDto, CommentResponseDto } from './dto/comment-response.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { PostIdParamDto } from './dto/post-id-param.dto';

/** Errors every comment endpoint can return: auth, rate limit and backing-service outages. */
const COMMON_ERRORS = [
  HttpStatus.UNAUTHORIZED,
  HttpStatus.FORBIDDEN,
  HttpStatus.TOO_MANY_REQUESTS,
  HttpStatus.SERVICE_UNAVAILABLE,
] as const;

const POST_NOT_FOUND = { status: HttpStatus.NOT_FOUND, description: 'No post has this ID.' };

/**
 * Comment endpoints (design §5.2). Comments are nested under /posts/:id for listing and
 * creating, but deleted by their own ID at /comments/:id, so the controller has no prefix.
 * Every route requires authentication.
 */
@ApiTags('Comments')
@ApiCookieAuth(ID_TOKEN_COOKIE)
@Controller()
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  /** A post's comments, newest first (FR-FEED-06). */
  @Get('posts/:id/comments')
  @ApiOperation({
    summary: "A post's comments, newest first (cursor-paginated)",
    description: 'Pass `nextCursor` from a page as `cursor` to get the next one (ADR-005).',
  })
  @ApiOkResponse({ type: CommentPageDto })
  @ApiErrorResponses(
    { status: HttpStatus.BAD_REQUEST, description: 'Invalid post ID, cursor or limit.' },
    POST_NOT_FOUND,
    ...COMMON_ERRORS,
  )
  list(
    @Param() params: PostIdParamDto,
    @Query() query: PaginationQueryDto,
  ): Promise<CommentPageDto> {
    return this.comments.list(params.id, query);
  }

  /** Adds a comment to a post (FR-FEED-06). */
  @Post('posts/:id/comments')
  @ApiOperation({ summary: 'Comment on a post' })
  @ApiCreatedResponse({ type: CommentResponseDto, description: 'The comment was added.' })
  @ApiErrorResponses(
    {
      status: HttpStatus.BAD_REQUEST,
      description: 'Invalid post ID, or the body is blank or longer than 500 characters.',
    },
    POST_NOT_FOUND,
    ...COMMON_ERRORS,
  )
  create(
    @Param() params: PostIdParamDto,
    @Body() dto: CreateCommentDto,
    @CurrentUser() user: User,
  ): Promise<CommentResponseDto> {
    return this.comments.create(user.id, params.id, dto);
  }

  /** Deletes the user's own comment (FR-FEED-06, NFR-SEC-02). */
  @Delete('comments/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete your own comment' })
  @ApiNoContentResponse({ description: 'The comment was deleted.' })
  @ApiErrorResponses(
    { status: HttpStatus.BAD_REQUEST, description: 'The ID is not a UUID.' },
    {
      status: HttpStatus.FORBIDDEN,
      description: 'The comment belongs to another user, or the account is disabled.',
    },
    { status: HttpStatus.NOT_FOUND, description: 'No comment has this ID.' },
    HttpStatus.UNAUTHORIZED,
    HttpStatus.TOO_MANY_REQUESTS,
    HttpStatus.SERVICE_UNAVAILABLE,
  )
  delete(@Param() params: CommentIdParamDto, @CurrentUser() user: User): Promise<void> {
    return this.comments.delete(user.id, params.id);
  }
}
