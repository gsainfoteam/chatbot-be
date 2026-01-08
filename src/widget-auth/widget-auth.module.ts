import { Module } from '@nestjs/common';
import { WidgetAuthController } from './widget-auth.controller';
import { WidgetAuthService } from './widget-auth.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [WidgetAuthController],
  providers: [WidgetAuthService],
})
export class WidgetAuthModule {}
