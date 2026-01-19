import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ListToolsResultSchema,
  CallToolResultSchema,
  LoggingMessageNotificationSchema,
  ResourceListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type {
  ListToolsRequest,
  CallToolRequest,
  ResourceLink,
} from '@modelcontextprotocol/sdk/types.js';

@Injectable()
export class McpClientService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(McpClientService.name);

  private client: any = null;
  private transport: any = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const baseUrl = this.config.get<string>('MCP_BASE_URL');
    if (!baseUrl) throw new Error('MCP_BASE_URL is required');

    // 1) Client 생성
    this.client = new Client(
      { name: 'Ziggle Chatbot MCP Client', version: '1.0.0' },
      {
        // NestJS 백엔드에서는 elicitation을 처리하기 어렵기 때문에
        // 기본은 비워두는 걸 추천.
        // capabilities: { ... }
      },
    );

    this.client.onerror = (err) => {
      this.logger.error(`MCP client error: ${String(err)}`);
    };

    // 2) Transport 생성 + connect
    this.transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    this.attachNotificationHandlers(this.client);

    await this.client.connect(this.transport);

    this.logger.log(
      `Connected to MCP server: ${baseUrl} (sessionId=${this.transport.sessionId ?? 'none'})`,
    );
  }

  async onModuleDestroy() {
    // 종료 훅에서는 "안전하게" 끊는 게 우선
    try {
      await this.transport?.close();
    } catch (e) {
      this.logger.warn(`Transport close failed: ${String(e)}`);
    }

    try {
      this.client?.close();
    } catch (e) {
      this.logger.warn(`Client close failed: ${String(e)}`);
    }

    this.transport = null;
    this.client = null;
  }

  private attachNotificationHandlers(client: Client) {
    // (선택) 서버가 로그/이벤트를 보내는 경우 NestJS 로그로 흡수
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      this.logger.log(
        `[MCP:${n.params.level}] ${typeof n.params.data === 'string' ? n.params.data : JSON.stringify(n.params.data)}`,
      );
    });

    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      this.logger.log(`Resource list changed (notification)`);
      // 필요하면 캐시 무효화 같은 처리
    });
  }

  private getConnectedClient(): Client {
    if (!this.client || !this.transport) {
      throw new Error('MCP client is not connected');
    }
    return this.client;
  }

  /** tools/list */
  async listTools() {
    const client = this.getConnectedClient();

    const req: ListToolsRequest = { method: 'tools/list', params: {} };
    const res = await client.request(req, ListToolsResultSchema);

    // 컨트롤러/서비스에서 쓰기 좋게 반환
    return res.tools.map((t) => ({
      name: t.name,
      description: t.description,
      // display name이 필요하면 getDisplayName 사용 가능(예제 참고)
    }));
  }

  /** tools/call */
  async callTool<
    TArgs extends Record<string, unknown> = Record<string, unknown>,
  >(name: string, args: TArgs) {
    const client = this.getConnectedClient();

    const req: CallToolRequest = {
      method: 'tools/call',
      params: { name, arguments: args },
    };

    const res = await client.request(req, CallToolResultSchema);

    // res.content는 text/resource_link/image/audio 등 다양한 타입이 섞여옴
    // 보통 백엔드에선 "text만 추출"하거나 "resource link만 추출"해서 상위 레이어로 넘기는 식으로 정리함.
    const texts: string[] = [];
    const resourceLinks: ResourceLink[] = [];

    for (const item of res.content) {
      if (item.type === 'text') texts.push(item.text);
      if (item.type === 'resource_link')
        resourceLinks.push(item as ResourceLink);
    }

    return {
      raw: res,
      texts,
      resourceLinks,
    };
  }
}
