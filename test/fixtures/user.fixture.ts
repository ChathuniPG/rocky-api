import type { User } from '../../src/generated/prisma/client';

/**
 * Builds a users row for unit tests. Lives under test/ so it is never compiled into
 * dist/ (tsconfig.build.json excludes test/).
 *
 * @param overrides - Fields to change from the defaults.
 * @returns A complete `User`.
 */
export function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: '6f1c1b1e-8d5a-4a4e-9a51-2b3c4d5e6f70',
    firebaseUid: 'firebase-uid-123',
    email: 'alice@example.com',
    username: 'alice',
    displayName: 'Alice',
    bio: null,
    avatarUrl: null,
    avatarPath: null,
    notificationsEnabled: true,
    language: 'en',
    createdAt: new Date('2026-11-01T10:00:00Z'),
    updatedAt: new Date('2026-11-01T10:00:00Z'),
    ...overrides,
  };
}
