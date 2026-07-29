import { describe, expect, it, jest } from '@jest/globals';
import { ResourceSelectionService } from './resource-selection.service';
import type { LlmResponse, LlmUsage } from '../types/llm.types';
import type { ListResourceItem } from '../../mcp/mcp-client.service';

function createLlmResponse(content: string, totalTokens = 10): LlmResponse {
  return {
    id: 'resp',
    model: 'test',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: Math.floor(totalTokens * 0.6),
      completion_tokens: totalTokens - Math.floor(totalTokens * 0.6),
      total_tokens: totalTokens,
    },
  };
}

describe('ResourceSelectionService', () => {
  type CallLLM = (...args: unknown[]) => Promise<LlmResponse>;

  function createService(callLLM: jest.Mock<CallLLM>) {
    const llmClient = {
      getModel: jest.fn((type: string) => `${type}-model`),
      callLLM,
      generateFinalResponseStream: jest.fn(),
    };
    return {
      service: new ResourceSelectionService(llmClient as never),
      llmClient,
    };
  }

  it('returns empty array when chunk resources are empty', async () => {
    const callLLM = jest.fn<CallLLM>();
    const { service } = createService(callLLM);

    await expect(
      service.selectRelevantChunkPaths('질문', [], 10),
    ).resolves.toEqual([]);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('parses chunk paths from JSON and accumulates token usage', async () => {
    const callLLM = jest
      .fn<CallLLM>()
      .mockResolvedValue(
        createLlmResponse('```json\n["a/b.md", "c/d.md"]\n```', 100),
      );
    const { service } = createService(callLLM);
    const usage: LlmUsage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    const resources: ListResourceItem[] = [
      {
        path: 'root',
        description: 'desc',
        chunks: [{ path: 'a/b.md', description: 'b' }],
      },
    ];

    const paths = await service.selectRelevantChunkPaths(
      '질문',
      resources,
      10,
      usage,
    );

    expect(paths).toEqual(['a/b.md', 'c/d.md']);
    expect(usage.total_tokens).toBe(100);
  });

  it('returns empty when path selection says 없음', async () => {
    const callLLM = jest
      .fn<CallLLM>()
      .mockResolvedValue(createLlmResponse('없음'));
    const { service } = createService(callLLM);

    const selected = await service.selectRelevantResourcePaths(
      '질문',
      [{ path: '학사편람/졸업.md', formats: ['md'] }],
      5,
    );

    expect(selected).toEqual([]);
  });

  it('selects documents by index numbers', async () => {
    const callLLM = jest
      .fn<CallLLM>()
      .mockResolvedValue(createLlmResponse('2, 1'));
    const { service } = createService(callLLM);
    const docs = [
      { title: 'a.md', content: 'aaa', path: 'a.md' },
      { title: 'b.md', content: 'bbb', path: 'b.md' },
      { title: 'c.md', content: 'ccc', path: 'c.md' },
    ];

    const selected = await service.selectMostRelevantDocuments('질문', docs);

    expect(selected.map((d) => d.path)).toEqual(['b.md', 'a.md']);
  });

  it('returns single document without calling LLM', async () => {
    const callLLM = jest.fn<CallLLM>();
    const { service } = createService(callLLM);
    const docs = [{ title: 'only.md', content: 'x', path: 'only.md' }];

    await expect(
      service.selectMostRelevantDocuments('질문', docs),
    ).resolves.toEqual(docs);
    expect(callLLM).not.toHaveBeenCalled();
  });
});
