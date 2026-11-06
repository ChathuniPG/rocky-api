import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { USER_NOT_FOUND } from './users.constants';

/**
 * Checks that a user exists, for operations that target another user by ID (follow,
 * start a conversation). Accepts the PrismaService or a transaction client.
 *
 * @param client - PrismaService or the caller's transaction client.
 * @param userId - The target user's internal ID.
 * @throws {NotFoundException} If no user has this ID.
 */
export async function assertUserExists(
  client: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  const user = await client.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) {
    throw new NotFoundException(USER_NOT_FOUND);
  }
}
