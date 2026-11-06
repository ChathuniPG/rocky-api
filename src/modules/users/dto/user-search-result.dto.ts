import { ApiProperty } from '@nestjs/swagger';
import { CursorPageDto } from '../../../common/pagination/cursor-page.dto';
import type { SearchResultRow } from '../user-query';

/** One user in the search results (FR-SRCH-01). Public fields only. */
export class UserSearchResultDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'alice' })
  username: string;

  @ApiProperty({ example: 'Alice' })
  displayName: string;

  @ApiProperty({ type: String, format: 'uri', nullable: true, example: null })
  avatarUrl: string | null;

  @ApiProperty({ description: 'Whether the signed-in user follows this user.' })
  isFollowing: boolean;

  /**
   * Maps a row selected with `searchResultSelect` to the response shape.
   *
   * @param row - The user with the viewer's follow, if any.
   * @returns The response DTO.
   */
  static fromRow(this: void, row: SearchResultRow): UserSearchResultDto {
    const dto = new UserSearchResultDto();
    dto.id = row.id;
    dto.username = row.username;
    dto.displayName = row.displayName;
    dto.avatarUrl = row.avatarUrl;
    // `followers` is filtered to the viewer, so it has zero or one entry.
    dto.isFollowing = row.followers.length > 0;
    return dto;
  }
}

/** One page of search results, ordered by username (ADR-005). */
export class UserSearchPageDto extends CursorPageDto(UserSearchResultDto) {}
