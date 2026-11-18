import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { MAX_RETURN_TO_LENGTH } from '../google/oauth-cookie';

/** Query of GET /auth/google (issue #42). */
export class GoogleSignInQueryDto {
  // Validated by the same safe-redirect rules as rocky-web's `next` (ADR-014); an unsafe
  // path is replaced by "/" rather than rejected, so a bad link still signs the user in.
  @ApiPropertyOptional({
    maxLength: MAX_RETURN_TO_LENGTH,
    example: '/settings',
    description:
      'Same-site path to return to after sign-in. Anything else (other hosts, //, /login, ' +
      '/signup, /welcome) is replaced by "/".',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_RETURN_TO_LENGTH)
  returnTo?: string;
}
