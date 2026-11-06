import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * Notifications (design §6): the notification endpoints, plus NotificationsService,
 * exported so PostsModule and UsersModule can create notifications inside their own
 * transactions. It imports neither of them, so there is no circular dependency.
 * PrismaService comes from the global PrismaModule.
 */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
