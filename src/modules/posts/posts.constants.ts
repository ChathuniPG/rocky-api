/** Longest caption (FR-POST-01); matches posts.caption varchar(2200). */
export const MAX_CAPTION_LENGTH = 2200;

/** Longest comment (FR-FEED-06); matches comments.body varchar(500). */
export const MAX_COMMENT_LENGTH = 500;

// Client-facing error messages, exported for tests.
export const POST_NOT_FOUND = 'Post not found';
export const NOT_POST_OWNER = 'You can only modify your own posts';
export const INVALID_MEDIA_PATH = 'mediaPath must be a post media path returned by POST /uploads';
export const MEDIA_NOT_OWNED = 'You can only create posts from your own uploads';
export const MEDIA_NOT_FOUND = 'No uploaded media exists at mediaPath';
export const UNSUPPORTED_MEDIA = 'The uploaded media has an unsupported type';
export const MEDIA_ALREADY_USED = 'This upload is already used by another post';
export const COMMENT_NOT_FOUND = 'Comment not found';
export const NOT_COMMENT_AUTHOR = 'You can only delete your own comments';
