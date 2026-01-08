import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DbModule } from './db/db.module';
import { AuthModule } from './auth/auth.module';
import { WidgetAuthModule } from './widget-auth/widget-auth.module';
import { WidgetMessagesModule } from './widget-messages/widget-messages.module';
import { AdminModule } from './admin/admin.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
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
