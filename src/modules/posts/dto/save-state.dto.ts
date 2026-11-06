import { ApiProperty } from '@nestjs/swagger';

/** Response of POST and DELETE /posts/:id/save (FR-FEED-04). */
export class SaveStateDto {
  @ApiProperty({ description: 'Whether the signed-in user now has the post saved.' })
  savedByMe: boolean;

  /**
   * @param savedByMe - The viewer's save state after the request.
   * @returns The response DTO.
   */
  static of(savedByMe: boolean): SaveStateDto {
    const dto = new SaveStateDto();
    dto.savedByMe = savedByMe;
    return dto;
  }
}
