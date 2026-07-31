import { describe, expect, it, jest } from '@jest/globals';
import { RetrievalService } from './retrieval.service';
import type { RetrievalRepository } from './retrieval.repository';

describe('RetrievalService', () => {
  it('builds new-format catalog and excludes docs handled by join (chunks required)', async () => {
    const repo = {
      listReadyWithChunks: jest.fn(async () => [
        {
          id: 'd1',
          title: '학사편람',
          resourceName: '학사편람',
          summary: '학사 안내',
          chunks: [
            {
              path: '학사편람/졸업요건',
              description: '졸업',
              sortOrder: 0,
            },
          ],
        },
      ]),
      findChunkContentsByPaths: jest.fn(),
    };

    const service = new RetrievalService(
      repo as unknown as RetrievalRepository,
    );
    const catalog = await service.listCatalog();

    expect(catalog.resources).toEqual([
      {
        path: '학사편람.pdf',
        description: '학사 안내',
        chunks: [{ path: '학사편람/졸업요건', description: '졸업' }],
      },
    ]);
    expect(catalog.chunks).toEqual([
      { path: '학사편람/졸업요건', description: '졸업' },
    ]);
    expect(catalog.total).toBe(1);
    expect(catalog.filteredResources).toEqual([]);
  });

  it('loads contents by path and strips .md for lookup', async () => {
    const repo = {
      listReadyWithChunks: jest.fn(),
      findChunkContentsByPaths: jest.fn(async (paths: string[]) => {
        expect(paths).toEqual(['학사편람/졸업요건']);
        return [{ path: '학사편람/졸업요건', content: '졸업 본문' }];
      }),
    };

    const service = new RetrievalService(
      repo as unknown as RetrievalRepository,
    );
    const hits = await service.getContentsByPaths(['학사편람/졸업요건.md']);
    expect(hits).toEqual([{ path: '학사편람/졸업요건', content: '졸업 본문' }]);
  });

  it('preserves dotted path segments that are not known extensions', async () => {
    const repo = {
      listReadyWithChunks: jest.fn(),
      findChunkContentsByPaths: jest.fn(async (paths: string[]) => {
        expect(paths).toEqual(['규정/3.2', '가이드/v1.2']);
        return paths.map((path) => ({ path, content: `${path} 본문` }));
      }),
    };
    const service = new RetrievalService(
      repo as unknown as RetrievalRepository,
    );

    const hits = await service.getContentsByPaths(['규정/3.2', '가이드/v1.2']);

    expect(hits).toHaveLength(2);
  });

  it('uses title when summary is empty', async () => {
    const repo = {
      listReadyWithChunks: jest.fn(async () => [
        {
          id: 'd1',
          title: '제목만',
          resourceName: 'doc',
          summary: '  ',
          chunks: [
            {
              path: 'doc/a',
              description: 'a',
              sortOrder: 0,
            },
          ],
        },
      ]),
      findChunkContentsByPaths: jest.fn(),
    };

    const service = new RetrievalService(
      repo as unknown as RetrievalRepository,
    );
    const catalog = await service.listCatalog();
    expect(catalog.resources?.[0]?.description).toBe('제목만');
  });
});
