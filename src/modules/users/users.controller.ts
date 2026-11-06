import { Body, Controller, Get, HttpStatus, Param, Patch, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ID_TOKEN_COOKIE } from '../../common/auth/auth-cookies';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator';
import type { User } from '../../generated/prisma/client';
import { UserResponseDto } from '../auth/dto/user-response.dto';
import { PostPageDto } from '../posts/dto/post-response.dto';
import { ProfileResponseDto } from './dto/profile-response.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UsernameParamDto } from './dto/username-param.dto';
import { UsersService } from './users.service';

/** Errors every user endpoint can return: auth, rate limit and backing-service outages. */
const COMMON_ERRORS = [
  HttpStatus.UNAUTHORIZED,
  HttpStatus.FORBIDDEN,
  HttpStatus.TOO_MANY_REQUESTS,
  HttpStatus.SERVICE_UNAVAILABLE,
] as const;

const USER_NOT_FOUND = { status: HttpStatus.NOT_FOUND, description: 'No user has this username.' };

/**
 * User endpoints (design §5.2). Every route requires authentication.
 *
 * Route order matters: Nest (Express) matches routes in declaration order, so the fixed
 * paths under `me` are declared before `:username`, which would
 * otherwise capture them. Those words are also reserved usernames, so no profile can
 * ever be shadowed by them.
 */
@ApiTags('Users')
@ApiCookieAuth(ID_TOKEN_COOKIE)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** The signed-in user's saved posts (FR-PROF-03). Only ever the caller's own. */
  @Get('me/saved')
  @ApiOperation({
    summary: 'Your saved posts, most recently saved first (cursor-paginated)',
    description: 'Pass `nextCursor` from a page as `cursor` to get the next one (ADR-005).',
  })
  @ApiOkResponse({ type: PostPageDto })
  @ApiErrorResponses(
    { status: HttpStatus.BAD_REQUEST, description: 'Invalid cursor or limit.' },
    ...COMMON_ERRORS,
  )
  savedPosts(@Query() query: PaginationQueryDto, @CurrentUser() user: User): Promise<PostPageDto> {
    return this.users.listSavedPosts(user.id, query);
  }

  /** Updates the signed-in user's profile and settings (FR-PROF-04, FR-SET-02, FR-SET-03). */
  @Patch('me')
  @ApiOperation({
    summary: 'Update your profile and settings',
    description:
      'Send at least one field. For a new avatar, send the `path` returned by POST /uploads ' +
      '(purpose `avatar`); the server verifies it and generates the URL. `avatarPath: null` ' +
      'removes the avatar. A replaced or removed avatar image is deleted.',
  })
  @ApiOkResponse({ type: UserResponseDto, description: 'The updated profile and settings.' })
  @ApiErrorResponses(
    {
      status: HttpStatus.BAD_REQUEST,
      description:
        'No field was sent, validation failed, or the avatar path is malformed, has no ' +
        'uploaded object, or is not a supported image.',
    },
    {
      status: HttpStatus.FORBIDDEN,
      description: "The avatar path is in another user's folder, or the account is disabled.",
    },
    HttpStatus.UNAUTHORIZED,
    HttpStatus.TOO_MANY_REQUESTS,
    HttpStatus.SERVICE_UNAVAILABLE,
  )
  updateMe(@Body() dto: UpdateProfileDto, @CurrentUser() user: User): Promise<UserResponseDto> {
    return this.users.updateProfile(user, dto);
  }

  /** A user's public profile, with counts and the caller's relation to it (FR-PROF-01). */
  @Get(':username')
  @ApiOperation({ summary: "A user's public profile" })
  @ApiOkResponse({ type: ProfileResponseDto })
  @ApiErrorResponses(
    { status: HttpStatus.BAD_REQUEST, description: 'The username is not a valid username.' },
    USER_NOT_FOUND,
    ...COMMON_ERRORS,
  )
  profile(
    @Param() params: UsernameParamDto,
    @CurrentUser() user: User,
  ): Promise<ProfileResponseDto> {
    return this.users.getProfile(user.id, params.username);
  }

  /** A user's posts, newest first, for the profile grid (FR-PROF-02). */
  @Get(':username/posts')
  @ApiOperation({
    summary: "A user's posts, newest first (cursor-paginated)",
    description: 'Pass `nextCursor` from a page as `cursor` to get the next one (ADR-005).',
  })
  @ApiOkResponse({ type: PostPageDto })
  @ApiErrorResponses(
    { status: HttpStatus.BAD_REQUEST, description: 'Invalid username, cursor or limit.' },
    USER_NOT_FOUND,
    ...COMMON_ERRORS,
  )
  userPosts(
    @Param() params: UsernameParamDto,
    @Query() query: PaginationQueryDto,
    @CurrentUser() user: User,
  ): Promise<PostPageDto> {
    return this.users.listUserPosts(user.id, params.username, query);
  }
}
