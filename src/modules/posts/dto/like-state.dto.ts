import { ApiProperty } from '@nestjs/swagger';

/** Response of POST and DELETE /posts/:id/like (FR-FEED-03). */
export class LikeStateDto {
  @ApiProperty({ description: 'Whether the signed-in user now likes the post.' })
  likedByMe: boolean;

  @ApiProperty({ example: 12, description: "The post's like count after the change." })
  likeCount: number;

  /**
   * @param likedByMe - The viewer's like state after the request.
   * @param likeCount - The post's like count after the request.
   * @returns The response DTO.
   */
  static of(likedByMe: boolean, likeCount: number): LikeStateDto {
    const dto = new LikeStateDto();
    dto.likedByMe = likedByMe;
    dto.likeCount = likeCount;
    return dto;
  }
}
