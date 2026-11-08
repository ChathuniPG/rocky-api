import { ApiProperty } from '@nestjs/swagger';

/** Number of conversations with unread messages, for the navigation badge (FR-MSG-06). */
export class UnreadConversationsCountDto {
  @ApiProperty({
    example: 2,
    minimum: 0,
    description:
      'Conversations with at least one unread message from the other participant. ' +
      'Several unread messages in one conversation count once.',
  })
  count: number;

  /**
   * @param count - The number of conversations with unread messages.
   * @returns The response DTO.
   */
  static of(count: number): UnreadConversationsCountDto {
    const dto = new UnreadConversationsCountDto();
    dto.count = count;
    return dto;
  }
}
