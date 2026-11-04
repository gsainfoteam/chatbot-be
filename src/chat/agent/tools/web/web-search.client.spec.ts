import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { WebSearchClient } from './web-search.client';
import type { GroundedSearchResponse } from '../../../types/llm.types';

function create(
  config: Record<string, unknown>,
  response?: GroundedSearchResponse,
) {
  const llmClient = {
    searchWithGoogle: jest.fn(
      async (): Promise<GroundedSearchResponse> =>
        response ?? { content: '', grounding: null },
    ),
  };
  const client = new WebSearchClient(
    llmClient as never,
    { get: (key: string) => config[key] } as never,
  );
  return { client, llmClient };
}

const usage = () => ({
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
});

describe('WebSearchClient', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('isEnabledFor', () => {
    it('is off unless WEB_SEARCH_ENABLED is true', () => {
      expect(
        create({ WEB_SEARCH_WIDGET_KEY_IDS: '*' }).client.isEnabledFor('w1'),
      ).toBe(false);
    });

    it('is on only for listed widgets, or all with *', () => {
      const listed = create({
        WEB_SEARCH_ENABLED: true,
        WEB_SEARCH_WIDGET_KEY_IDS: 'w1,w2',
      }).client;
      expect(listed.isEnabledFor('w2')).toBe(true);
      expect(listed.isEnabledFor('w3')).toBe(false);
      expect(
        create({
          WEB_SEARCH_ENABLED: 'true',
          WEB_SEARCH_WIDGET_KEY_IDS: '*',
        }).client.isEnabledFor('any'),
      ).toBe(true);
    });
  });

  it('calls the configured model with Google Search grounding', async () => {
    const { client, llmClient } = create({ WEB_SEARCH_MODEL: 'gemini-x' });

    await client.search('GIST 기숙사 외박', usage());

    const [messages, model, options] = llmClient.searchWithGoogle.mock
      .calls[0] as unknown as [
      Array<{ role: string; content: string }>,
      string,
      { timeoutMs: number },
    ];
    expect(model).toBe('gemini-x');
    expect(messages.at(-1)).toEqual({
      role: 'user',
      content: 'GIST 기숙사 외박',
    });
    expect(options.timeoutMs).toBe(15000);
  });

  it('returns nothing when the model did not search', async () => {
    const { client } = create({}, { content: '아마도 11시', grounding: null });

    await expect(client.search('q', usage())).resolves.toEqual({
      findings: [],
      queries: [],
    });
  });

  it('adds token usage and resolves only the sources used as evidence', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      headers: new Headers({ location: 'https://dorm.gist.ac.kr/rule' }),
    } as Response);
    const { client } = create(
      {},
      {
        content: '통금은 없다.',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        grounding: {
          queries: ['GIST 기숙사 통금'],
          chunks: [
            {
              uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/a',
              title: 'gist.ac.kr',
            },
            {
              uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/b',
              title: 'unused.com',
            },
          ],
          supports: [{ text: '통금은 없다.', chunkIndices: [0] }],
        },
      },
    );
    const total = usage();

    const result = await client.search('GIST 기숙사 통금', total);

    expect(total.total_tokens).toBe(15);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.findings).toEqual([
      {
        text: '통금은 없다.',
        sources: [
          {
            url: 'https://dorm.gist.ac.kr/rule',
            domain: 'dorm.gist.ac.kr',
            official: true,
            resolved: true,
          },
        ],
      },
    ]);
  });
});
