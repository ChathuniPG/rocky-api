import { ApiProperty } from '@nestjs/swagger';

/** Number of unread notifications, for the navigation badge (FR-NOTF-04). */
export class UnreadCountDto {
  @ApiProperty({ example: 3, minimum: 0 })
  count: number;

  /**
   * @param count - The number of unread notifications.
   * @returns The response DTO.
   */
  static of(count: number): UnreadCountDto {
    const dto = new UnreadCountDto();
    dto.count = count;
    return dto;
  }
}
