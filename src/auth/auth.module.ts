import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InfoteamIdpModule } from '@lib/infoteam-idp';
import { AdminJwtStrategy } from './strategies/admin-jwt.strategy';
import { AdminJwtGuard } from './guards/admin-jwt.guard';
import { AdminAuthService } from './admin-auth.service';
import { AuthController } from './auth.controller';
import { DbModule } from '../db/db.module';

@Module({
  imports: [
    DbModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const secret = configService.get<string>('JWT_SECRET');
        const nodeEnv = configService.get<string>('NODE_ENV', 'development');

        // JWT Secret 검증
        if (!secret) {
          throw new Error(
            'JWT_SECRET is required. Please set JWT_SECRET in environment variables.',
          );
        }

        // 프로덕션 환경에서 취약한 시크릿 사용 방지
        if (nodeEnv === 'production') {
          const weakSecrets = [
            'default-secret-key',
            'secret',
            'jwt-secret',
            'your-secret-key',
            'change-me',
            'test',
          ];

          if (weakSecrets.includes(secret.toLowerCase())) {
            throw new Error(
              `JWT_SECRET is too weak for production environment. Please use a strong secret key.`,
            );
          }

          if (secret.length < 32) {
            throw new Error(
              `JWT_SECRET must be at least 32 characters long in production environment. Current length: ${secret.length}`,
            );
          }
        }

        return {
          secret,
          signOptions: {
            expiresIn: configService.get<string>('JWT_EXPIRES_IN', '3600s'),
          },
        };
      },
    }),
    InfoteamIdpModule,
  ],
  controllers: [AuthController],
  providers: [AdminAuthService, AdminJwtStrategy, AdminJwtGuard],
  exports: [JwtModule, AdminAuthService, AdminJwtStrategy, AdminJwtGuard],
})
export class AuthModule {}
