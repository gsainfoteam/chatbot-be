import { describe, expect, it, jest } from '@jest/globals';
import { of } from 'rxjs';
import { LetsurLlmService } from './letsur-llm.service';
import { parseGoogleSearchGrounding } from './base-openai-compatible.llm';
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

describe('BaseOpenAiCompatibleLlm.searchWithGoogle', () => {
  it('turns on Google Search grounding and returns parsed grounding', async () => {
    const post = jest.fn((_url: string, _body: unknown) =>
      of({
        data: {
          choices: [{ message: { content: '통금은 없다.' } }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          vertex_ai_grounding_metadata: [
            {
              webSearchQueries: ['GIST 통금'],
              groundingChunks: [
                { web: { uri: 'https://r/1', title: 'gist.ac.kr' } },
              ],
              groundingSupports: [
                {
                  segment: { text: '통금은 없다.' },
                  groundingChunkIndices: [0],
                },
              ],
            },
          ],
        },
      }),
    );
    const config: Record<string, string> = {
      LETSUR_AI_GATEWAY_API_KEY: 'k',
      LETSUR_AI_GATEWAY_BASE_URL: 'https://gw.example.com/v1',
    };
    const service = new LetsurLlmService(
      { post } as never,
      {
        get: (key: string) => config[key],
        getOrThrow: (key: string) => config[key],
      } as never,
    );

    const result = await service.searchWithGoogle(
      [{ role: 'user', content: 'GIST 통금' }],
      'gemini-2.5-flash',
    );

    expect(post.mock.calls[0][1]).toMatchObject({
      model: 'gemini-2.5-flash',
      tools: [{ googleSearch: {} }],
      temperature: 0,
    });
    expect(result).toEqual({
      content: '통금은 없다.',
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      grounding: {
        queries: ['GIST 통금'],
        chunks: [{ uri: 'https://r/1', title: 'gist.ac.kr' }],
        supports: [{ text: '통금은 없다.', chunkIndices: [0] }],
      },
    });
  });
});

describe('parseGoogleSearchGrounding', () => {
  it('returns null when the model did not search', () => {
    expect(parseGoogleSearchGrounding([])).toBeNull();
    expect(parseGoogleSearchGrounding(undefined)).toBeNull();
    expect(
      parseGoogleSearchGrounding([
        { webSearchQueries: [], groundingChunks: [], groundingSupports: [] },
      ]),
    ).toBeNull();
  });

  it('drops out-of-range chunk indices and blank segments, and keeps the entry point', () => {
    expect(
      parseGoogleSearchGrounding({
        groundingChunks: [{ web: { uri: 'u', title: 't' } }],
        groundingSupports: [
          { segment: { text: ' 근거 ' }, groundingChunkIndices: [0, 3, -1] },
          { segment: { text: '  ' }, groundingChunkIndices: [0] },
        ],
        searchEntryPoint: { renderedContent: '<div>chip</div>' },
      }),
    ).toEqual({
      queries: [],
      chunks: [{ uri: 'u', title: 't' }],
      supports: [{ text: '근거', chunkIndices: [0] }],
      searchEntryPointHtml: '<div>chip</div>',
    });
  });
});
