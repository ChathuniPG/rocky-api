import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

/**
 * Notifications (design §6). Exports NotificationsService so PostsModule and UsersModule
 * can create notifications inside their own transactions. It imports neither of them, so
 * there is no circular dependency. PrismaService comes from the global PrismaModule.
 */
@Module({
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
