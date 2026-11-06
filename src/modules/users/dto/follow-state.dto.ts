import { ApiProperty } from '@nestjs/swagger';

/** Response of POST and DELETE /users/:id/follow (FR-PROF-05). */
export class FollowStateDto {
  @ApiProperty({ description: 'Whether the signed-in user now follows the user.' })
  isFollowing: boolean;

  @ApiProperty({ example: 340, description: "The user's follower count after the change." })
  followerCount: number;

  /**
   * @param isFollowing - The viewer's follow state after the request.
   * @param followerCount - The followed user's follower count after the request.
   * @returns The response DTO.
   */
  static of(isFollowing: boolean, followerCount: number): FollowStateDto {
    const dto = new FollowStateDto();
    dto.isFollowing = isFollowing;
    dto.followerCount = followerCount;
    return dto;
  }
}
