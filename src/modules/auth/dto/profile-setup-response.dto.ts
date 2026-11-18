import { ApiProperty } from '@nestjs/swagger';
import { MAX_DISPLAY_NAME_LENGTH } from '../../users/users.constants';

/**
 * Response of GET /auth/profile-setup (issue #42, FR-AUTH-10): prefilled values for the
 * /welcome form of a signed-in user who has no profile yet. The suggested username was
 * free when the response was built; it is not reserved and is checked again on submit.
 */
export class ProfileSetupResponseDto {
  @ApiProperty({ format: 'email', example: 'alice@gmail.com', description: 'From the ID token.' })
  email: string;

  @ApiProperty({
    maxLength: MAX_DISPLAY_NAME_LENGTH,
    example: 'Alice Smith',
    description: 'The Google account name, or the email local part if there is none.',
  })
  displayName: string;

  @ApiProperty({
    example: 'alice',
    description: 'A valid username that was free when this response was built.',
  })
  suggestedUsername: string;
}
