import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** Body of POST /conversations (FR-PROF-06, FR-MSG-01). */
export class CreateConversationDto {
  @ApiProperty({ format: 'uuid', description: 'ID of the user to message.' })
  @IsUUID('all')
  recipientId: string;
}
