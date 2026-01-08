import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DbModule } from './db/db.module';
import { AuthModule } from './auth/auth.module';
import { WidgetAuthModule } from './widget-auth/widget-auth.module';
import { WidgetMessagesModule } from './widget-messages/widget-messages.module';
import { AdminModule } from './admin/admin.module';
import { validate } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate, // 환경 변수 검증 추가
    }),
    DbModule,
    AuthModule,
    WidgetAuthModule,
    WidgetMessagesModule,
    AdminModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
