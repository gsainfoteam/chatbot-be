import { describe, expect, it, jest } from '@jest/globals';
import {
  buildVectorCandidateCatalog,
  RetrievalService,
} from './retrieval.service';
import type { RetrievalRepository } from './retrieval.repository';

describe('RetrievalService', () => {
  function createService(repo: object): RetrievalService {
    return new RetrievalService(
      repo as unknown as RetrievalRepository,
      { get: jest.fn() } as never,
      {
        model: 'embedding-model',
        dimensions: 1536,
        embedTexts: jest.fn(),
      } as never,
    );
  }

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

    const service = createService(repo);
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

    const service = createService(repo);
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
    const service = createService(repo);

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

    const service = createService(repo);
    const catalog = await service.listCatalog();
    expect(catalog.resources?.[0]?.description).toBe('제목만');
  });

  it('deduplicates vector candidates, groups documents, and includes roots', () => {
    const candidate = {
      chunkId: 'c1',
      documentId: 'd1',
      title: '학사편람',
      resourceName: '학사편람',
      summary: '학사 안내',
      path: '학사편람/졸업',
      description: '졸업',
      sortOrder: 1,
      distance: 0.1,
    };
    const catalog = buildVectorCandidateCatalog(
      [
        candidate,
        { ...candidate },
        {
          ...candidate,
          chunkId: 'c2',
          path: '학사편람/수강',
          description: '수강',
          distance: 0.2,
        },
        {
          ...candidate,
          chunkId: 'c3',
          documentId: 'd2',
          title: '생활편람',
          resourceName: '생활편람',
          summary: null,
          path: '생활편람',
          description: '생활 개요',
          distance: 0.3,
        },
      ],
      [
        {
          ...candidate,
          chunkId: 'root-1',
          path: '학사편람',
          description: '학사 개요',
        },
        {
          ...candidate,
          chunkId: 'c3',
          documentId: 'd2',
          title: '생활편람',
          resourceName: '생활편람',
          summary: null,
          path: '생활편람',
          description: '생활 개요',
        },
      ],
    );

    expect(catalog.resources).toEqual([
      {
        path: '학사편람.pdf',
        description: '학사 안내',
        chunks: [
          { path: '학사편람', description: '학사 개요' },
          { path: '학사편람/졸업', description: '졸업' },
          { path: '학사편람/수강', description: '수강' },
        ],
      },
      {
        path: '생활편람.pdf',
        description: '생활편람',
        chunks: [{ path: '생활편람', description: '생활 개요' }],
      },
    ]);
    expect(catalog.chunks).toHaveLength(4);
  });

  it('falls back when question embedding or vector retrieval fails', async () => {
    const repo = {
      hasIncompleteReadyEmbeddings: jest.fn(async () => false),
      findSimilarChunks: jest.fn(),
      findRootChunksForDocuments: jest.fn(),
    };
    const embeddingClient = {
      model: 'embedding-model',
      dimensions: 1536,
      embedTexts: jest.fn(async () => {
        throw new Error('endpoint unavailable');
      }),
    };
    const service = new RetrievalService(
      repo as unknown as RetrievalRepository,
      {
        get: jest.fn((key: string) =>
          key === 'RAG_VECTOR_SEARCH_ENABLED' ? true : 20,
        ),
      } as never,
      embeddingClient as never,
    );

    await expect(service.getVectorCatalog('질문')).resolves.toEqual({
      available: false,
      reason: expect.stringContaining('endpoint unavailable'),
    });
    expect(repo.findSimilarChunks).not.toHaveBeenCalled();
  });

  it('falls back before calling the endpoint when backfill is incomplete', async () => {
    const repo = {
      hasIncompleteReadyEmbeddings: jest.fn(async () => true),
    };
    const embeddingClient = {
      model: 'embedding-model',
      dimensions: 1536,
      embedTexts: jest.fn(),
    };
    const service = new RetrievalService(
      repo as unknown as RetrievalRepository,
      {
        get: jest.fn((key: string) =>
          key === 'RAG_VECTOR_SEARCH_ENABLED' ? true : 20,
        ),
      } as never,
      embeddingClient as never,
    );

    await expect(service.getVectorCatalog('질문')).resolves.toEqual({
      available: false,
      reason: 'ready document embedding backfill is incomplete',
    });
    expect(embeddingClient.embedTexts).not.toHaveBeenCalled();
  });
});
