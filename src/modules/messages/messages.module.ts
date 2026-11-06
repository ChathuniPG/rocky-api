import { Module } from '@nestjs/common';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';

/**
 * Direct messages (design §6): one-to-one conversations and their messages, delivered by
 * polling (ADR-008). PrismaService comes from the global PrismaModule; the user-existence
 * check is a plain function from the users module, so UsersModule is not imported.
 */
@Module({
  controllers: [ConversationsController],
  providers: [ConversationsService],
})
export class MessagesModule {}
