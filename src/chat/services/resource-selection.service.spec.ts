import { describe, expect, it, jest } from '@jest/globals';
import { ResourceSelectionService } from './resource-selection.service';
import type { LlmResponse, LlmUsage } from '../types/llm.types';
import type { ListResourceItem } from '../../retrieval/retrieval.types';

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
    ).resolves.toEqual({ rootPaths: [], detailPaths: [] });
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('maps selected numbers to detail paths and adds their root overview', async () => {
    const callLLM = jest
      .fn<CallLLM>()
      .mockResolvedValue(createLlmResponse('```json\n[2, 1]\n```', 100));
    const { service } = createService(callLLM);
    const usage: LlmUsage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    const resources: ListResourceItem[] = [
      {
        path: '학사편람.pdf',
        description: '학사 안내',
        chunks: [
          { path: '학사편람', description: '문서 개요' },
          { path: '학사편람/수강신청', description: '수강신청 방법' },
          { path: '학사편람/졸업', description: '졸업 요건' },
        ],
      },
    ];

    const selected = await service.selectRelevantChunkPaths(
      '질문',
      resources,
      10,
      usage,
    );

    expect(selected).toEqual({
      rootPaths: ['학사편람'],
      detailPaths: ['학사편람/졸업', '학사편람/수강신청'],
    });
    expect(usage.total_tokens).toBe(100);
  });

  it('ignores invalid and duplicate chunk numbers', async () => {
    const callLLM = jest
      .fn<CallLLM>()
      .mockResolvedValue(createLlmResponse('[1, 1, 99, "경로"]'));
    const { service } = createService(callLLM);
    const resources: ListResourceItem[] = [
      {
        path: '학사편람.pdf',
        description: '학사 안내',
        chunks: [
          { path: '학사편람', description: '문서 개요' },
          { path: '학사편람/수강신청', description: '수강신청 방법' },
        ],
      },
    ];

    await expect(
      service.selectRelevantChunkPaths('수강신청', resources, 5),
    ).resolves.toEqual({
      rootPaths: ['학사편람'],
      detailPaths: ['학사편람/수강신청'],
    });
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
