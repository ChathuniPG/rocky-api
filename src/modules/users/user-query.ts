import type { Prisma } from '../../generated/prisma/client';

/**
 * The columns a public profile needs, for a given viewer (FR-PROF-01). Only public fields
 * are selected: email, firebaseUid and avatarPath are never read, so they cannot leak.
 *
 * Everything comes from one statement: Prisma computes the three relation counts as
 * subqueries, and `followers` filtered to the viewer returns at most one row, served by
 * the follows primary key (follower_id, following_id). It is empty unless the viewer
 * follows this user.
 *
 * @param viewerId - Internal ID of the signed-in user.
 * @returns A Prisma `select` for `user` queries.
 */
export function profileSelect(viewerId: string) {
  return {
    id: true,
    username: true,
    displayName: true,
    bio: true,
    avatarUrl: true,
    createdAt: true,
    _count: { select: { posts: true, followers: true, following: true } },
    followers: { where: { followerId: viewerId }, select: { followerId: true }, take: 1 },
  } satisfies Prisma.UserSelect;
}

/** A user row as returned by a query using {@link profileSelect}. */
export type ProfileRow = Prisma.UserGetPayload<{ select: ReturnType<typeof profileSelect> }>;
