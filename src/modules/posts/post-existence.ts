import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { POST_NOT_FOUND } from './posts.constants';

/**
 * Throws 404 unless a post with this ID exists. Shared by every endpoint nested under
 * /posts/:id (likes, saves, comments), so a missing post is always reported the same
 * way instead of surfacing as a foreign-key error from the insert.
 *
 * @param client - PrismaService, or the transaction client inside `$transaction`.
 * @param postId - The post's ID.
 * @throws {NotFoundException} If no post has this ID.
 */
export async function assertPostExists(
  client: Prisma.TransactionClient,
  postId: string,
): Promise<void> {
  const post = await client.post.findUnique({ where: { id: postId }, select: { id: true } });
  if (!post) {
    throw new NotFoundException(POST_NOT_FOUND);
  }
}
