import type { Prisma } from '../../generated/prisma/client';

/**
 * The columns every message response needs. Shared by the list, poll and send queries so
 * the response shape cannot drift between them.
 */
export const messageSelect = {
  id: true,
  conversationId: true,
  senderId: true,
  body: true,
  readAt: true,
  createdAt: true,
} satisfies Prisma.MessageSelect;

/** A message row as returned by a query using {@link messageSelect}. */
export type MessageRow = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;
