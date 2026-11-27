import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { McpToolClient } from './mcp-tool-client';

const API_KEY = 'k'.repeat(32);

/** Ziggle MCP처럼 요청마다 새 서버를 만드는 stateless Streamable HTTP 서버 */
function startServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.headers['x-api-key'] !== API_KEY) {
      res.writeHead(401).end();
      return;
    }
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const mcp = new McpServer({ name: 'test', version: '1.0.0' });
      mcp.registerTool(
        'echo',
        { description: 'echo', inputSchema: { text: z.string() } },
        ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }),
      );
      mcp.registerTool('broken', { description: 'broken' }, () => ({
        isError: true,
        content: [{ type: 'text', text: 'not found' }],
      }));
      mcp.registerTool(
        'slow',
        { description: 'slow' },
        () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ content: [{ type: 'text', text: 'late' }] }),
              500,
            ),
          ),
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      void mcp
        .connect(transport)
        .then(() =>
          transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined),
        );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/mcp` });
    }),
  );
}

describe('McpToolClient', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    ({ server, url } = await startServer());
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const client = (overrides: { apiKey?: string; timeoutMs?: number } = {}) =>
    new McpToolClient({
      name: 'test',
      url,
      headers: { 'x-api-key': overrides.apiKey ?? API_KEY },
      timeoutMs: overrides.timeoutMs ?? 2000,
    });

  it('calls a tool with the configured headers and returns its text', async () => {
    await expect(client().callTool('echo', { text: '안녕' })).resolves.toEqual({
      text: 'echo:안녕',
      isError: false,
    });
  });

  it('reports a tool-level error without throwing', async () => {
    await expect(client().callTool('broken', {})).resolves.toEqual({
      text: 'not found',
      isError: true,
    });
  });

  it('rejects when the server refuses the API key', async () => {
    await expect(
      client({ apiKey: 'wrong' }).callTool('echo', { text: 'x' }),
    ).rejects.toThrow();
  });

  it('rejects when a call takes longer than the timeout', async () => {
    await expect(
      client({ timeoutMs: 100 }).callTool('slow', {}),
    ).rejects.toThrow();
  });
});
