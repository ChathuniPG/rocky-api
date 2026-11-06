import { Module } from '@nestjs/common';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';

/**
 * POST /uploads (design §6). FirebaseStorageService comes from the global FirebaseModule.
 * UploadsService is exported so later modules (e.g. posts, #7) can reuse the upload rules.
 */
@Module({
  controllers: [UploadsController],
  providers: [UploadsService],
  exports: [UploadsService],
})
export class UploadsModule {}
