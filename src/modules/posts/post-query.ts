import type { Prisma } from '../../generated/prisma/client';

/**
 * The columns every post response needs, for a given viewer. Shared by all post queries
 * (create, read, feed, and later profiles and saved posts) so the response shape cannot
 * drift between endpoints.
 *
 * likedByMe / savedByMe come from relation counts filtered to the viewer. Prisma computes
 * these as subqueries inside the main SELECT on posts, so a page costs the same number of
 * statements whatever its size: no per-post query (no N+1). The (user_id, post_id)
 * primary keys of likes and saves serve each count as a single index lookup.
 *
 * @param viewerId - Internal ID of the signed-in user.
 * @returns A Prisma `select` for `post` queries.
 */
export function postSelect(viewerId: string) {
  return {
    id: true,
    caption: true,
    mediaUrl: true,
    mediaType: true,
    likeCount: true,
    commentCount: true,
    createdAt: true,
    updatedAt: true,
    author: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
    _count: {
      select: {
        likes: { where: { userId: viewerId } },
        saves: { where: { userId: viewerId } },
      },
    },
  } satisfies Prisma.PostSelect;
}

/** A post row as returned by a query using {@link postSelect}. */
export type PostRow = Prisma.PostGetPayload<{ select: ReturnType<typeof postSelect> }>;
