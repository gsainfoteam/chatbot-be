import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ChatController } from './chat.controller';
import { ChatService } from './services/chat.service';
import { ChatOrchestrationService } from './services/chat-orchestration.service';
import { ResourceSelectionService } from './services/resource-selection.service';
import { ResourceContentService } from './services/resource-content.service';
import { ChatStreamTransport } from './services/chat-stream.transport';
import { AuthModule } from '../auth/auth.module';
import { McpModule } from '../mcp/mcp.module';
import { UsageModule } from '../usage/usage.module';
import { LLM_CLIENT } from './llm/llm-client.interface';
import { llmClientProvider } from './llm/llm-client.provider';

@Module({
  imports: [HttpModule, AuthModule, McpModule, UsageModule],
  controllers: [ChatController],
  providers: [
    ChatService,
    llmClientProvider,
    ResourceSelectionService,
    ResourceContentService,
    ChatStreamTransport,
    ChatOrchestrationService,
  ],
  exports: [LLM_CLIENT],
})
export class ChatModule {}
