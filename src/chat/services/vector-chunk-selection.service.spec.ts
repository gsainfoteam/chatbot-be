import { describe, expect, it, jest } from '@jest/globals';
import { VectorChunkSelectionService } from './vector-chunk-selection.service';

type SearchHit = { path: string; resourceName: string; distance: number };

function createService(options: {
  embeddingEnabled?: boolean;
  embedText?: () => Promise<number[]>;
  hits?: SearchHit[];
  searchError?: Error;
  config?: Record<string, string>;
}) {
  const embeddingService = {
    isEnabled: jest.fn(() => options.embeddingEnabled ?? true),
    embedText: jest.fn<() => Promise<number[]>>(
      options.embedText ?? (() => Promise.resolve([0.1, 0.2])),
    ),
  };
  const retrievalService = {
    searchChunksByEmbedding: jest.fn<() => Promise<SearchHit[]>>(() =>
      options.searchError
        ? Promise.reject(options.searchError)
        : Promise.resolve(options.hits ?? []),
    ),
  };
  const configService = {
    get: jest.fn((key: string, defaultValue?: string) => {
      return options.config?.[key] ?? defaultValue;
    }),
  };

  return {
    service: new VectorChunkSelectionService(
      embeddingService as never,
      retrievalService as never,
      configService as never,
    ),
    embeddingService,
    retrievalService,
  };
}

describe('VectorChunkSelectionService', () => {
  it('returns null when embedding API is disabled', async () => {
    const { service, retrievalService } = createService({
      embeddingEnabled: false,
    });

    await expect(service.selectRelevantChunkPaths('질문')).resolves.toBeNull();
    expect(retrievalService.searchChunksByEmbedding).not.toHaveBeenCalled();
  });

  it('returns null when kill-switch env disables vector retrieval', async () => {
    const { service, embeddingService } = createService({
      config: { EMBEDDING_RETRIEVAL_ENABLED: 'false' },
    });

    await expect(service.selectRelevantChunkPaths('질문')).resolves.toBeNull();
    expect(embeddingService.embedText).not.toHaveBeenCalled();
  });

  it('returns null when question embedding fails', async () => {
    const { service } = createService({
      embedText: () => Promise.reject(new Error('boom')),
    });

    await expect(service.selectRelevantChunkPaths('질문')).resolves.toBeNull();
  });

  it('returns null when no embedded chunks exist (pre-backfill)', async () => {
    const { service } = createService({ hits: [] });

    await expect(service.selectRelevantChunkPaths('질문')).resolves.toBeNull();
  });

  it('maps detail hits to detailPaths and adds their root overview', async () => {
    const { service } = createService({
      hits: [
        { path: '학사편람/졸업', resourceName: '학사편람', distance: 0.3 },
        { path: '학사편람', resourceName: '학사편람', distance: 0.4 },
        { path: '장학안내/신청', resourceName: '장학안내', distance: 0.5 },
      ],
    });

    await expect(service.selectRelevantChunkPaths('질문', 5)).resolves.toEqual({
      rootPaths: ['학사편람', '장학안내'],
      detailPaths: ['학사편람/졸업', '장학안내/신청'],
    });
  });

  it('returns an empty selection when all hits exceed the distance threshold', async () => {
    const { service } = createService({
      hits: [
        { path: '학사편람/졸업', resourceName: '학사편람', distance: 0.95 },
      ],
    });

    await expect(
      service.selectRelevantChunkPaths('무관한 질문'),
    ).resolves.toEqual({ rootPaths: [], detailPaths: [] });
  });

  it('respects a custom EMBEDDING_MAX_DISTANCE', async () => {
    const { service } = createService({
      config: { EMBEDDING_MAX_DISTANCE: '0.4' },
      hits: [
        { path: '학사편람/졸업', resourceName: '학사편람', distance: 0.3 },
        { path: '장학안내/신청', resourceName: '장학안내', distance: 0.6 },
      ],
    });

    await expect(service.selectRelevantChunkPaths('질문')).resolves.toEqual({
      rootPaths: ['학사편람'],
      detailPaths: ['학사편람/졸업'],
    });
  });

  it('returns null when vector search itself fails', async () => {
    const { service } = createService({
      searchError: new Error('db down'),
    });

    await expect(service.selectRelevantChunkPaths('질문')).resolves.toBeNull();
  });
});
