import type { Prisma } from '../../generated/prisma/client';

/**
 * The viewer's own follow of a user, as a relation filtered to the viewer: zero or one
 * row, served by the follows primary key (follower_id, following_id). Non-empty means the
 * viewer follows this user.
 */
function viewerFollowSelect(viewerId: string) {
  return {
    where: { followerId: viewerId },
    select: { followerId: true },
    take: 1,
  } satisfies Prisma.FollowFindManyArgs;
}

/**
 * The columns a public profile needs, for a given viewer (FR-PROF-01). Only public fields
 * are selected: email, firebaseUid and avatarPath are never read, so they cannot leak.
 *
 * Everything comes from one statement: Prisma computes the three relation counts and the
 * viewer's follow as subqueries of the users query.
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
    followers: viewerFollowSelect(viewerId),
  } satisfies Prisma.UserSelect;
}

/** A user row as returned by a query using {@link profileSelect}. */
export type ProfileRow = Prisma.UserGetPayload<{ select: ReturnType<typeof profileSelect> }>;

/**
 * The columns of one search result (FR-SRCH-01), for a given viewer. As with profiles,
 * the viewer's follow is part of the same statement, so a page has no per-row query.
 *
 * @param viewerId - Internal ID of the signed-in user.
 * @returns A Prisma `select` for `user` queries.
 */
export function searchResultSelect(viewerId: string) {
  return {
    id: true,
    username: true,
    displayName: true,
    avatarUrl: true,
    followers: viewerFollowSelect(viewerId),
  } satisfies Prisma.UserSelect;
}

/** A user row as returned by a query using {@link searchResultSelect}. */
export type SearchResultRow = Prisma.UserGetPayload<{
  select: ReturnType<typeof searchResultSelect>;
}>;
