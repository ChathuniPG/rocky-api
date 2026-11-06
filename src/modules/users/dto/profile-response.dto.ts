import { ApiProperty } from '@nestjs/swagger';
import type { ProfileRow } from '../user-query';

/**
 * A user's public profile (FR-PROF-01). Built field by field from a row selected with
 * `profileSelect`, so private columns (email, firebaseUid, avatarPath, settings) never
 * appear.
 */
export class ProfileResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'alice' })
  username: string;

  @ApiProperty({ example: 'Alice' })
  displayName: string;

  @ApiProperty({ type: String, nullable: true, example: 'Coffee and sunsets' })
  bio: string | null;

  @ApiProperty({ type: String, format: 'uri', nullable: true, example: null })
  avatarUrl: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ example: 12 })
  postCount: number;

  @ApiProperty({ example: 340, description: 'Users who follow this user.' })
  followerCount: number;

  @ApiProperty({ example: 87, description: 'Users this user follows.' })
  followingCount: number;

  @ApiProperty({ description: 'Whether the signed-in user follows this user.' })
  isFollowing: boolean;

  @ApiProperty({ description: "Whether this is the signed-in user's own profile." })
  isMe: boolean;

  /**
   * Maps a row selected with `profileSelect` to the response shape.
   *
   * @param row - The user with its counts and the viewer's follow, if any.
   * @param viewerId - Internal ID of the signed-in user, for `isMe`.
   * @returns The response DTO.
   */
  static fromRow(row: ProfileRow, viewerId: string): ProfileResponseDto {
    // `_count` is Prisma's name for relation counts.
    const { _count: counts } = row;
    const dto = new ProfileResponseDto();
    dto.id = row.id;
    dto.username = row.username;
    dto.displayName = row.displayName;
    dto.bio = row.bio;
    dto.avatarUrl = row.avatarUrl;
    dto.createdAt = row.createdAt;
    dto.postCount = counts.posts;
    dto.followerCount = counts.followers;
    dto.followingCount = counts.following;
    // `followers` is filtered to the viewer, so it has zero or one entry.
    dto.isFollowing = row.followers.length > 0;
    dto.isMe = row.id === viewerId;
    return dto;
  }
}
