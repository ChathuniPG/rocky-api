import type { User } from '../../../generated/prisma/client';

/**
 * The signed-in user's own profile and settings, returned by signup, login and
 * GET /auth/me. Built field by field, so internal columns such as `firebaseUid` and
 * `updatedAt` can never leak by accident when the users table grows.
 */
export class UserResponseDto {
  id: string;
  email: string;
  username: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  notificationsEnabled: boolean;
  language: string;
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
