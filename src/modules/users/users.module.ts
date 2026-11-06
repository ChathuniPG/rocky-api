import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { FollowsService } from './follows.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * Profiles, profile updates, user and saved posts, search and follows (design §6).
 * PrismaService and FirebaseStorageService come from the global PrismaModule and
 * FirebaseModule. The post response shape (postSelect, PostResponseDto) and the media-path
 * rules are plain functions and classes, so PostsModule and UploadsModule are not imported.
 * NotificationsModule provides the service that notifies followed users.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [UsersController],
  providers: [UsersService, FollowsService],
})
export class UsersModule {}
