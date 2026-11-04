import { Logger } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export type McpServerConfig = {
  /** 로그에 표시할 서버 이름 */
  name: string;
  url: string;
  /** 인증 헤더 등. 로그에 남기지 않는다. */
  headers?: Record<string, string>;
  /** 연결(initialize)과 도구 호출 각각의 시간 상한 */
  timeoutMs: number;
};

export type McpToolCallResult = {
  /** text content를 이어 붙인 값 */
  text: string;
  /** 서버가 도구 실행 오류(isError)로 응답했는지 */
  isError: boolean;
};

/**
 * Streamable HTTP MCP 서버의 도구를 호출하는 범용 클라이언트.
 * stateless 서버(요청마다 새 세션)를 전제로 호출마다 연결하고 끝나면 닫는다.
 */
export class McpToolClient {
  private readonly logger: Logger;

  constructor(private readonly config: McpServerConfig) {
    this.logger = new Logger(`McpToolClient:${config.name}`);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolCallResult> {
    signal?.throwIfAborted();
    const client = new Client(
      { name: 'GIST Chatbot', version: '1.0.0' },
      { capabilities: {} },
    );
    client.onerror = (error) =>
      this.logger.debug(`MCP client error: ${String(error)}`);
    const transport = new StreamableHTTPClientTransport(
      new URL(this.config.url),
      { requestInit: { headers: this.config.headers, signal } },
    );

    const abort = () => {
      void transport.close().catch(() => undefined);
    };
    signal?.addEventListener('abort', abort, { once: true });
    const startedAt = Date.now();
    try {
      await client.connect(transport, { timeout: this.config.timeoutMs });
      const result = await client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: this.config.timeoutMs },
      );
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .filter(
          (part): part is { type: 'text'; text: string } =>
            typeof part === 'object' &&
            part !== null &&
            (part as { type?: unknown }).type === 'text' &&
            typeof (part as { text?: unknown }).text === 'string',
        )
        .map((part) => part.text)
        .join('\n');
      this.logger.debug(
        `[PERF] ${name}: ${Date.now() - startedAt}ms (isError=${Boolean(result.isError)})`,
      );
      return { text, isError: Boolean(result.isError) };
    } finally {
      signal?.removeEventListener('abort', abort);
      await transport.close().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  }
}
