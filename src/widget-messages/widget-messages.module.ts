import { Module } from '@nestjs/common';
import { WidgetMessagesController } from './widget-messages.controller';
import { WidgetMessagesService } from './widget-messages.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [WidgetMessagesController],
  providers: [WidgetMessagesService],
})
export class WidgetMessagesModule {}
