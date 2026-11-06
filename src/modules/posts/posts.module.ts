import { Module } from '@nestjs/common';
import { PostEngagementService } from './post-engagement.service';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';

/**
 * Posts, the feed, and likes and saves of posts (design §6). PrismaService and FirebaseStorageService come from the
 * global PrismaModule and FirebaseModule; the media-path rules are plain functions from
 * the uploads module, so UploadsModule does not need to be imported.
 */
@Module({
  controllers: [PostsController],
  providers: [PostsService, PostEngagementService],
})
export class PostsModule {}
