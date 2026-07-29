import { describe, expect, it, jest } from '@jest/globals';
import { ResourceContentService } from './resource-content.service';
import type { ListResourcesResult } from '../../mcp/mcp-client.service';
import type { LlmUsage } from '../types/llm.types';

describe('ResourceContentService', () => {
  type CallTool = (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<unknown>;

  it('appends unique top-level PDF entries for FE resources', () => {
    const service = new ResourceContentService(
      { callTool: jest.fn() } as never,
      {} as never,
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
    const mcpClientService = {
      callTool: jest.fn<CallTool>(async () => ({
        raw: {},
        texts: ['chunk body'],
        resourceLinks: [],
        embeddedResources: [],
        filteredResources: [],
      })),
    };
    const resourceSelectionService = {
      selectRelevantChunkPaths: jest
        .fn<(...args: unknown[]) => Promise<string[]>>()
        .mockResolvedValue(['학사편람/졸업.md']),
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
      mcpClientService as never,
      resourceSelectionService as never,
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
    expect(mcpClientService.callTool).toHaveBeenCalledWith('get_resource', {
      path: '학사편람/졸업',
    });
    expect(result.content).toContain('chunk body');
    expect(result.usedResources.some((r) => r.path.includes('학사편람'))).toBe(
      true,
    );
  });

  it('returns empty when legacy filteredResources has no markdown', async () => {
    const service = new ResourceContentService(
      { callTool: jest.fn() } as never,
      {
        selectRelevantResourcePaths: jest.fn(),
      } as never,
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
