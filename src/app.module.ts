import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { FirebaseAuthGuard } from './common/guards/firebase-auth.guard';
import {
  DEFAULT_THROTTLE,
  DEFAULT_THROTTLER,
  TOO_MANY_REQUESTS_MESSAGE,
} from './common/throttling/throttling.constants';
import { validateEnv } from './config/env.validation';
import { FirebaseModule } from './firebase/firebase.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PostsModule } from './modules/posts/posts.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { UsersModule } from './modules/users/users.module';
import { PrismaModule } from './prisma/prisma.module';

/** Root module: wires infrastructure and feature modules together. */
@Module({
  imports: [
    // Global so every module can inject ConfigService without re-importing ConfigModule.
    // `validate` runs once at startup: invalid configuration stops the app (fail fast).
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    // NFR-SEC-05: per-IP rate limiting with in-memory counters (ADR-012).
    ThrottlerModule.forRoot({
      throttlers: [{ name: DEFAULT_THROTTLER, ...DEFAULT_THROTTLE }],
      errorMessage: TOO_MANY_REQUESTS_MESSAGE,
    }),
    PrismaModule,
    FirebaseModule,
    AuthModule,
    HealthModule,
    UploadsModule,
    PostsModule,
    UsersModule,
    NotificationsModule,
  ],
  providers: [
    // Global guards run in the order listed. The throttler comes first, so a flood of
    // requests is rejected before any Firebase token verification or database lookup.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // NFR-SEC-01: every route requires authentication unless marked @Public().
    { provide: APP_GUARD, useClass: FirebaseAuthGuard },
  ],
})
export class AppModule {}
