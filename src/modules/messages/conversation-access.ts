import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { CONVERSATION_NOT_FOUND } from './messages.constants';

/**
 * Throws 404 unless the conversation exists and the user is one of its two participants.
 * Shared by every endpoint under /conversations/:id.
 *
 * NFR-SEC-02: the participant check is part of the WHERE, so someone else's conversation
 * looks exactly like a missing one (404, not 403) and its existence is not revealed.
 *
 * @param client - PrismaService, or the transaction client inside `$transaction`.
 * @param conversationId - The conversation's ID.
 * @param userId - Internal ID of the signed-in user.
 * @throws {NotFoundException} If the user has no conversation with this ID.
 */
export async function assertParticipant(
  client: Prisma.TransactionClient,
  conversationId: string,
  userId: string,
): Promise<void> {
  const conversation = await client.conversation.findFirst({
    where: { id: conversationId, OR: [{ userAId: userId }, { userBId: userId }] },
    select: { id: true },
  });
  if (!conversation) {
    throw new NotFoundException(CONVERSATION_NOT_FOUND);
  }
}
