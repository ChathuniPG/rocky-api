/**
 * Usernames that cannot be registered, because they collide with API routes
 * (/users/me, /users/search) or with frontend routes (design §7.1), or could be mistaken
 * for an official account. Compared after the username is lowercased.
 */
export const RESERVED_USERNAMES: readonly string[] = [
  'admin',
  'api',
  'auth',
  'login',
  'logout',
  'me',
  'messages',
  'notifications',
  'posts',
  'search',
  'settings',
  'signup',
  'uploads',
];

/** FR-SET-03: English plus one additional language (Sinhala). */
export const SUPPORTED_LANGUAGES = ['en', 'si'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** Matches users.display_name varchar(50). */
export const MAX_DISPLAY_NAME_LENGTH = 50;

/** Matches users.bio varchar(160). */
export const MAX_BIO_LENGTH = 160;

/** Matches the users_username_format CHECK constraint (FR-AUTH-02). */
export const USERNAME_PATTERN = /^[a-z0-9_.]{3,30}$/;

// Client-facing error messages, exported for tests.
export const RESERVED_USERNAME = 'username is reserved';
export const USER_NOT_FOUND = 'User not found';
export const EMPTY_PROFILE_UPDATE = 'At least one field must be provided';
export const INVALID_AVATAR_PATH = 'avatarPath must be an avatar path returned by POST /uploads';
export const AVATAR_NOT_OWNED = 'You can only use your own uploads as your avatar';
export const AVATAR_NOT_FOUND = 'No uploaded image exists at avatarPath';
export const UNSUPPORTED_AVATAR = 'The uploaded avatar is not a supported image';
