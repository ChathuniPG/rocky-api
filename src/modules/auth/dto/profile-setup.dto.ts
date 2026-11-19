import { PickType } from '@nestjs/swagger';
import { SignupDto } from './signup.dto';

/**
 * Request body of POST /auth/profile-setup (issue #42, FR-AUTH-10). `PickType` copies the
 * two fields with their validation, transforms and Swagger metadata from `SignupDto`, so a
 * Google user's username and display name follow exactly the sign-up rules (format,
 * length, reserved names). Comparable to reusing a Bean Validation group in Spring.
 */
export class ProfileSetupDto extends PickType(SignupDto, ['username', 'displayName'] as const) {}
