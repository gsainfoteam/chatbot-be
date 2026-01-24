import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { McpClientService } from './mcp-client.service';
import { McpResourceService } from './mcp-resource.service';

@Module({
  imports: [HttpModule],
  providers: [McpClientService, McpResourceService],
  exports: [McpClientService, McpResourceService],
})
export class McpModule {}
