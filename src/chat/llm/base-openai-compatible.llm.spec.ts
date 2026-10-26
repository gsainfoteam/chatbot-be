import { describe, expect, it, jest } from '@jest/globals';
import { of } from 'rxjs';
import { LetsurLlmService } from './letsur-llm.service';
import type { LlmRequest, LlmTool } from '../types/llm.types';

function createService() {
  const post = jest.fn((_url: string, _body: LlmRequest) =>
    of({ data: { id: 'r', model: 'm', choices: [] } }),
  );
  const config: Record<string, string> = {
    LETSUR_AI_GATEWAY_API_KEY: 'test-key',
    LETSUR_AI_GATEWAY_BASE_URL: 'https://gw.example.com/v1',
  };
  const configService = {
    get: jest.fn((key: string) => config[key]),
    getOrThrow: jest.fn((key: string) => config[key]),
  };
  const service = new LetsurLlmService(
    { post } as never,
    configService as never,
  );
  return { service, post };
}

const TOOL: LlmTool = {
  type: 'function',
  function: {
    name: 'search_documents',
    description: '문서 검색',
    parameters: { type: 'object' },
  },
};

describe('BaseOpenAiCompatibleLlm.callLLM', () => {
  it('does not send tool fields for a plain completion', async () => {
    const { service, post } = createService();

    await service.callLLM([{ role: 'user', content: 'hi' }]);

    const body = post.mock.calls[0][1];
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('sends tools with the requested tool choice', async () => {
    const { service, post } = createService();

    await service.callLLM([{ role: 'user', content: 'hi' }], 'model', {
      tools: [TOOL],
      tool_choice: 'auto',
      parallel_tool_calls: true,
    });

    expect(post.mock.calls[0][1]).toMatchObject({
      tools: [TOOL],
      tool_choice: 'auto',
      parallel_tool_calls: true,
    });
  });

  it('ignores tool choice when no tools are given', async () => {
    const { service, post } = createService();

    await service.callLLM([{ role: 'user', content: 'hi' }], 'model', {
      tools: [],
      tool_choice: 'required',
    });

    expect(post.mock.calls[0][1]).not.toHaveProperty('tool_choice');
  });
});
