import { describe, expect, it, jest } from '@jest/globals';
import { ResourceContentService } from './resource-content.service';
import type { ListResourcesResult } from '../../retrieval/retrieval.types';
import type { RelevantChunkSelection } from './resource-selection.service';
import type { LlmUsage } from '../types/llm.types';

function createDisabledVectorSelection() {
  return {
    selectRelevantChunkPaths: jest.fn<
      (...args: unknown[]) => Promise<RelevantChunkSelection | null>
    >(async () => null),
  };
}

describe('ResourceContentService', () => {
  it('appends unique top-level PDF entries for FE resources', () => {
    const service = new ResourceContentService(
      { getContentsByPaths: jest.fn() } as never,
      {} as never,
      createDisabledVectorSelection() as never,
    );
    const out: Array<{ path: string; formats: string[]; url: string }> = [];
    const seen = new Set<string>();

    service.appendFePdfResourceEntryFromUsed(out, seen, {
      path: '학사편람/졸업요건.md',
      formats: ['md'],
    });
    service.appendFePdfResourceEntryFromUsed(out, seen, {
      path: '학사편람/세부/표.png',
      formats: ['png'],
    });
    service.appendFePdfResourceEntryFromUsed(out, seen, {
      path: '학사편람.pdf',
      formats: ['pdf'],
    });

    expect(out).toEqual([
      {
        path: '학사편람.pdf',
        formats: ['pdf'],
        url: encodeURIComponent('학사편람.pdf'),
      },
    ]);
  });

  it('uses new-format chunk pipeline when resources+chunks exist', async () => {
    const retrievalService = {
      getContentsByPaths: jest.fn(async (_paths: string[]) => [
        { path: '학사편람', content: 'root overview' },
        { path: '학사편람/졸업', content: 'chunk body' },
      ]),
    };
    const resourceSelectionService = {
      selectRelevantChunkPaths: jest
        .fn<
          (
            ...args: unknown[]
          ) => Promise<{ rootPaths: string[]; detailPaths: string[] }>
        >()
        .mockResolvedValue({
          rootPaths: ['학사편람'],
          detailPaths: ['학사편람/졸업'],
        }),
      selectMostRelevantDocuments: jest
        .fn<
          (
            ...args: unknown[]
          ) => Promise<Array<{ title: string; content: string; path: string }>>
        >()
        .mockResolvedValue([
          {
            title: '졸업.md',
            content: 'chunk body',
            path: '학사편람/졸업.md',
          },
        ]),
      selectRelevantResourcePaths: jest.fn(),
    };

    const service = new ResourceContentService(
      retrievalService as never,
      resourceSelectionService as never,
      createDisabledVectorSelection() as never,
    );

    const listResult = {
      raw: {},
      texts: [],
      resourceLinks: [],
      embeddedResources: [],
      filteredResources: [],
      resources: [
        {
          path: '학사편람',
          description: '학사',
          chunks: [{ path: '학사편람/졸업.md', description: '졸업' }],
        },
      ],
      chunks: [{ path: '학사편람/졸업.md', description: '졸업' }],
    } as ListResourcesResult;

    const usage: LlmUsage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    const result = await service.fetchRelevantResourceContents(
      '졸업 요건',
      listResult,
      usage,
    );

    expect(
      resourceSelectionService.selectRelevantChunkPaths,
    ).toHaveBeenCalled();
    expect(
      resourceSelectionService.selectRelevantResourcePaths,
    ).not.toHaveBeenCalled();
    expect(retrievalService.getContentsByPaths).toHaveBeenCalledWith([
      '학사편람',
      '학사편람/졸업',
    ]);
    expect(
      resourceSelectionService.selectMostRelevantDocuments,
    ).not.toHaveBeenCalled();
    expect(result.content).toContain('root overview');
    expect(result.content).toContain('chunk body');
    expect(result.content).toContain('## 관련 정보');
    expect(result.content).not.toContain('## 리소스:');
    expect(result.usedResources.some((r) => r.path.includes('학사편람'))).toBe(
      true,
    );
  });

  it('uses vector selection when available and skips LLM selection', async () => {
    const retrievalService = {
      getContentsByPaths: jest.fn(async (_paths: string[]) => [
        { path: '학사편람', content: 'root overview' },
        { path: '학사편람/졸업', content: 'chunk body' },
      ]),
    };
    const resourceSelectionService = {
      selectRelevantChunkPaths: jest.fn(),
      selectMostRelevantDocuments: jest.fn(),
      selectRelevantResourcePaths: jest.fn(),
    };
    const vectorChunkSelectionService = {
      selectRelevantChunkPaths: jest
        .fn<(...args: unknown[]) => Promise<RelevantChunkSelection | null>>()
        .mockResolvedValue({
          rootPaths: ['학사편람'],
          detailPaths: ['학사편람/졸업'],
        }),
    };

    const service = new ResourceContentService(
      retrievalService as never,
      resourceSelectionService as never,
      vectorChunkSelectionService as never,
    );

    const listResult = {
      raw: {},
      texts: [],
      resourceLinks: [],
      embeddedResources: [],
      filteredResources: [],
      resources: [
        {
          path: '학사편람',
          description: '학사',
          chunks: [{ path: '학사편람/졸업.md', description: '졸업' }],
        },
      ],
      chunks: [{ path: '학사편람/졸업.md', description: '졸업' }],
    } as ListResourcesResult;

    const result = await service.fetchRelevantResourceContents(
      '졸업 요건',
      listResult,
    );

    expect(
      vectorChunkSelectionService.selectRelevantChunkPaths,
    ).toHaveBeenCalledWith('졸업 요건', 5);
    expect(
      resourceSelectionService.selectRelevantChunkPaths,
    ).not.toHaveBeenCalled();
    expect(retrievalService.getContentsByPaths).toHaveBeenCalledWith([
      '학사편람',
      '학사편람/졸업',
    ]);
    expect(result.content).toContain('root overview');
    expect(result.content).toContain('chunk body');
  });

  it('returns empty when legacy filteredResources has no markdown', async () => {
    const service = new ResourceContentService(
      { getContentsByPaths: jest.fn() } as never,
      {
        selectRelevantResourcePaths: jest.fn(),
      } as never,
      createDisabledVectorSelection() as never,
    );

    const listResult = {
      raw: {},
      texts: [],
      resourceLinks: [],
      embeddedResources: [],
      filteredResources: [{ path: '학사편람.pdf', formats: ['pdf'] }],
    } as ListResourcesResult;

    await expect(
      service.fetchRelevantResourceContents('질문', listResult),
    ).resolves.toEqual({ content: '', usedResources: [] });
  });
});
