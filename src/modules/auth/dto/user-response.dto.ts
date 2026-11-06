import { ApiProperty } from '@nestjs/swagger';
import type { User } from '../../../generated/prisma/client';

/**
 * The signed-in user's own profile and settings, returned by signup, login and
 * GET /auth/me. Built field by field, so internal columns such as `firebaseUid` and
 * `updatedAt` can never leak by accident when the users table grows.
 */
export class UserResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'email', example: 'alice@example.com' })
  email: string;

  @ApiProperty({ example: 'alice' })
  username: string;

  @ApiProperty({ example: 'Alice' })
  displayName: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  bio: string | null;

  @ApiProperty({ type: String, format: 'uri', nullable: true, example: null })
  avatarUrl: string | null;

  @ApiProperty({ example: true })
  notificationsEnabled: boolean;

  @ApiProperty({ example: 'en' })
  language: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  /**
   * Maps a users row to the response shape.
   *
   * @param user - The row from PostgreSQL.
   * @returns The response DTO, without `firebaseUid`.
   */
  static fromUser(user: User): UserResponseDto {
    const dto = new UserResponseDto();
    dto.id = user.id;
    dto.email = user.email;
    dto.username = user.username;
    dto.displayName = user.displayName;
    dto.bio = user.bio;
    dto.avatarUrl = user.avatarUrl;
    dto.notificationsEnabled = user.notificationsEnabled;
    dto.language = user.language;
    dto.createdAt = user.createdAt;
    return dto;
  }
}
