import type { Prisma } from '../../generated/prisma/client';

/**
 * The columns every notification response needs. The actor, post and comment are joined in
 * the same statement, so a page of notifications is one query (no N+1). Internal columns
 * such as `recipientId` and the post's `mediaPath` are never selected.
 */
export const notificationSelect = {
  id: true,
  type: true,
  isRead: true,
  createdAt: true,
  actor: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
  post: { select: { id: true, mediaUrl: true, mediaType: true } },
  comment: { select: { id: true, body: true } },
} satisfies Prisma.NotificationSelect;

/** A notification row as returned by a query using {@link notificationSelect}. */
export type NotificationRow = Prisma.NotificationGetPayload<{ select: typeof notificationSelect }>;
