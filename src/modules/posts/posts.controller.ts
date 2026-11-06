import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ID_TOKEN_COOKIE } from '../../common/auth/auth-cookies';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import type { User } from '../../generated/prisma/client';
import { CreatePostDto } from './dto/create-post.dto';
import { PostIdParamDto } from './dto/post-id-param.dto';
import { PostPageDto, PostResponseDto } from './dto/post-response.dto';
import { PostsService } from './posts.service';

/** Post endpoints (design §5.2). Every route requires authentication. */
@ApiTags('Posts')
@ApiCookieAuth(ID_TOKEN_COOKIE)
@Controller('posts')
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  /** Creates a post from a previously uploaded media path (FR-POST-01, ADR-007). */
  @Post()
  @ApiOperation({ summary: 'Create a post from an uploaded media path' })
  @ApiCreatedResponse({ type: PostResponseDto })
  create(@Body() dto: CreatePostDto, @CurrentUser() user: User): Promise<PostResponseDto> {
    return this.posts.create(user.id, dto);
  }

  /**
   * The home feed, newest first (FR-FEED-01). Declared before `:id` so "feed" is never
   * treated as a post ID.
   */
  @Get('feed')
  @ApiOperation({ summary: 'Home feed, newest first (cursor-paginated)' })
  @ApiOkResponse({ type: PostPageDto })
  feed(@Query() query: PaginationQueryDto, @CurrentUser() user: User): Promise<PostPageDto> {
    return this.posts.getFeed(user.id, query);
  }

  /** A single post, for its own page and shared links (FR-POST-06). */
  @Get(':id')
  @ApiOperation({ summary: 'A single post' })
  @ApiOkResponse({ type: PostResponseDto })
  findOne(@Param() params: PostIdParamDto, @CurrentUser() user: User): Promise<PostResponseDto> {
    return this.posts.findById(user.id, params.id);
  }
}
