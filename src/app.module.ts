import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { validateEnv } from './config/env.validation';

/** Root module: wires infrastructure and feature modules together. */
@Module({
  imports: [
    // Global so every module can inject ConfigService without re-importing ConfigModule.
    // `validate` runs once at startup: invalid configuration stops the app (fail fast).
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
