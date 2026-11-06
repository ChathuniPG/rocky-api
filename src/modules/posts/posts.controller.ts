import {
  Body,
  Controller,
  Delete,
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
import { ID_TOKEN_COOKIE } from '../../common/auth/auth-cookies';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator';
import type { User } from '../../generated/prisma/client';
import { CreatePostDto } from './dto/create-post.dto';
import { PostIdParamDto } from './dto/post-id-param.dto';
import { PostPageDto, PostResponseDto } from './dto/post-response.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { PostsService } from './posts.service';

/** Errors every post endpoint can return: auth, rate limit and backing-service outages. */
const COMMON_ERRORS = [
  HttpStatus.UNAUTHORIZED,
  HttpStatus.TOO_MANY_REQUESTS,
  HttpStatus.SERVICE_UNAVAILABLE,
] as const;

const NOT_FOUND = { status: HttpStatus.NOT_FOUND, description: 'No post has this ID.' };
const INVALID_ID = {
  status: HttpStatus.BAD_REQUEST,
  description: 'The ID is not a UUID, or the body failed validation.',
};
const NOT_OWNER = {
  status: HttpStatus.FORBIDDEN,
  description: 'The post belongs to another user, or the account is disabled.',
};

/** Post endpoints (design §5.2). Every route requires authentication. */
@ApiTags('Posts')
@ApiCookieAuth(ID_TOKEN_COOKIE)
@Controller('posts')
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  /** Creates a post from a previously uploaded media path (FR-POST-01, ADR-007). */
  @Post()
  @ApiOperation({
    summary: 'Create a post from an uploaded media path',
    description:
      'Send the `path` returned by POST /uploads (purpose `post`). The server checks that ' +
      'the path is yours and the object exists, and takes the media type and URL from ' +
      'Storage; nothing else about the file is accepted from the client.',
  })
  @ApiCreatedResponse({ type: PostResponseDto, description: 'The post was created.' })
  @ApiErrorResponses(
    {
      status: HttpStatus.BAD_REQUEST,
      description:
        'Validation failed, the media path is malformed, no uploaded object exists at it, ' +
        'or its type is not allowed.',
    },
    {
      status: HttpStatus.FORBIDDEN,
      description: "The media path is in another user's folder, or the account is disabled.",
    },
    { status: HttpStatus.CONFLICT, description: 'Another post already uses this upload.' },
    ...COMMON_ERRORS,
  )
  create(@Body() dto: CreatePostDto, @CurrentUser() user: User): Promise<PostResponseDto> {
    return this.posts.create(user.id, dto);
  }

  /**
   * The home feed, newest first (FR-FEED-01). Declared before `:id` so "feed" is never
   * treated as a post ID.
   */
  @Get('feed')
  @ApiOperation({
    summary: 'Home feed, newest first (cursor-paginated)',
    description: 'Pass `nextCursor` from a page as `cursor` to get the next one (ADR-005).',
  })
  @ApiOkResponse({ type: PostPageDto })
  @ApiErrorResponses(
    { status: HttpStatus.BAD_REQUEST, description: 'Invalid cursor or limit.' },
    HttpStatus.FORBIDDEN,
    ...COMMON_ERRORS,
  )
  feed(@Query() query: PaginationQueryDto, @CurrentUser() user: User): Promise<PostPageDto> {
    return this.posts.getFeed(user.id, query);
  }

  /** A single post, for its own page and shared links (FR-POST-06). */
  @Get(':id')
  @ApiOperation({ summary: 'A single post' })
  @ApiOkResponse({ type: PostResponseDto })
  @ApiErrorResponses(INVALID_ID, HttpStatus.FORBIDDEN, NOT_FOUND, ...COMMON_ERRORS)
  findOne(@Param() params: PostIdParamDto, @CurrentUser() user: User): Promise<PostResponseDto> {
    return this.posts.findById(user.id, params.id);
  }

  /** Edits the caption of the user's own post (FR-POST-04, NFR-SEC-02). */
  @Patch(':id')
  @ApiOperation({ summary: 'Edit the caption of your own post' })
  @ApiOkResponse({ type: PostResponseDto, description: 'The updated post.' })
  @ApiErrorResponses(INVALID_ID, NOT_OWNER, NOT_FOUND, ...COMMON_ERRORS)
  update(
    @Param() params: PostIdParamDto,
    @Body() dto: UpdatePostDto,
    @CurrentUser() user: User,
  ): Promise<PostResponseDto> {
    return this.posts.updateCaption(user.id, params.id, dto);
  }

  /** Deletes the user's own post and its media (FR-POST-05, NFR-SEC-02). */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete your own post and its media',
    description: "Also removes the post's likes, saves, comments and notifications.",
  })
  @ApiNoContentResponse({ description: 'The post was deleted.' })
  @ApiErrorResponses(INVALID_ID, NOT_OWNER, NOT_FOUND, ...COMMON_ERRORS)
  delete(@Param() params: PostIdParamDto, @CurrentUser() user: User): Promise<void> {
    return this.posts.delete(user.id, params.id);
  }
}
