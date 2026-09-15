import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { McpResourceService } from './mcp-resource.service';

@Module({
  imports: [HttpModule],
  providers: [McpResourceService],
  exports: [McpResourceService],
})
export class McpModule {}
