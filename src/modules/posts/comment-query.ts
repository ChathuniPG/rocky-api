import type { Prisma } from '../../generated/prisma/client';

/**
 * The columns every comment response needs. Shared by the list and create queries so the
 * response shape cannot drift between them. The author is joined in the same statement,
 * so a page of comments is one query (no N+1).
 */
export const commentSelect = {
  id: true,
  postId: true,
  body: true,
  createdAt: true,
  author: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
} satisfies Prisma.CommentSelect;

/** A comment row as returned by a query using {@link commentSelect}. */
export type CommentRow = Prisma.CommentGetPayload<{ select: typeof commentSelect }>;
