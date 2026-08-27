import { afterEach, describe, expect, it, jest } from '@jest/globals';
import axios from 'axios';
import type { ConfigService } from '@nestjs/config';
import { OpenAiCompatibleEmbeddingClient } from './openai-compatible-embedding.client';

function createClient(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    EMBEDDING_BASE_URL: 'https://embedding.example/v1/',
    EMBEDDING_API_KEY: 'test-key',
    EMBEDDING_MODEL: 'test-model',
    EMBEDDING_DIMENSIONS: 3,
    EMBEDDING_BATCH_SIZE: 2,
    ...overrides,
  };
  const config = {
    getOrThrow: jest.fn((key: string) => {
      const value = values[key];
      if (value == null) throw new Error(`missing ${key}`);
      return value;
    }),
    get: jest.fn((key: string) => values[key]),
  };
  return new OpenAiCompatibleEmbeddingClient(
    config as unknown as ConfigService,
  );
}

describe('OpenAiCompatibleEmbeddingClient', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('preserves input order across batches using response indexes', async () => {
    const post = jest
      .spyOn(axios, 'post')
      .mockResolvedValueOnce({
        data: {
          data: [
            { index: 1, embedding: [0, 1, 0] },
            { index: 0, embedding: [1, 0, 0] },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { data: [{ index: 0, embedding: [0, 0, 1] }] },
      });

    await expect(createClient().embedTexts(['a', 'b', 'c'])).resolves.toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][0]).toBe(
      'https://embedding.example/v1/embeddings',
    );
    expect(post.mock.calls[0][1]).toMatchObject({
      model: 'test-model',
      input: ['a', 'b'],
      dimensions: 3,
    });
  });

  it('returns immediately for an empty input array', async () => {
    const post = jest.spyOn(axios, 'post');
    await expect(createClient().embedTexts([])).resolves.toEqual([]);
    expect(post).not.toHaveBeenCalled();
  });

  it('rejects blank input without calling the provider', async () => {
    const post = jest.spyOn(axios, 'post');
    await expect(createClient().embedTexts([' \r\n '])).rejects.toThrow(
      /index 0 is empty/,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('rejects an empty provider response', async () => {
    jest.spyOn(axios, 'post').mockResolvedValue({ data: { data: [] } });
    await expect(createClient().embedTexts(['a'])).rejects.toThrow(
      /empty response/,
    );
  });

  it('rejects an embedding dimension mismatch', async () => {
    jest.spyOn(axios, 'post').mockResolvedValue({
      data: { data: [{ index: 0, embedding: [1, 2] }] },
    });
    await expect(createClient().embedTexts(['a'])).rejects.toThrow(
      /expected 3, received 2/,
    );
  });

  it('wraps API errors without exposing the API key', async () => {
    jest.spyOn(axios, 'post').mockRejectedValue(new Error('network down'));
    const error = await createClient()
      .embedTexts(['a'])
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Embedding API request failed');
    expect((error as Error).message).not.toContain('test-key');
  });
});
