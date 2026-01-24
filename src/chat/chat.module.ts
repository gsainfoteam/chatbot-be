import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ChatController } from './chat.controller';
import { ChatService } from './services/chat.service';
import { OpenRouterService } from './services/open-router.service';
import { ChatOrchestrationService } from './services/chat-orchestration.service';
import { AuthModule } from '../auth/auth.module';
import { McpModule } from '../mcp/mcp.module';

@Module({
  imports: [HttpModule, AuthModule, McpModule],
  controllers: [ChatController],
  providers: [ChatService, OpenRouterService, ChatOrchestrationService],
  exports: [OpenRouterService],
})
export class ChatModule {}
