import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { FirebaseAuthGuard } from './common/guards/firebase-auth.guard';
import { validateEnv } from './config/env.validation';
import { FirebaseModule } from './firebase/firebase.module';
import { PrismaModule } from './prisma/prisma.module';

/** Root module: wires infrastructure and feature modules together. */
@Module({
  imports: [
    // Global so every module can inject ConfigService without re-importing ConfigModule.
    // `validate` runs once at startup: invalid configuration stops the app (fail fast).
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    PrismaModule,
    FirebaseModule,
  ],
  providers: [
    // NFR-SEC-01: every route requires authentication unless marked @Public().
    { provide: APP_GUARD, useClass: FirebaseAuthGuard },
  ],
})
export class AppModule {}
