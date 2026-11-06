import { Module } from '@nestjs/common';
import { AuthCookieService } from './auth-cookie.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

/**
 * Sign-up, login, refresh, logout and the current user (design §3, §5.2). PrismaService
 * and the Firebase services come from their global modules. The guard itself lives in
 * common/ and is registered globally in AppModule.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthCookieService],
})
export class AuthModule {}
