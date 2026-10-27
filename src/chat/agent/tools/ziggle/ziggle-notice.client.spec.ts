import { describe, expect, it, jest } from '@jest/globals';
import { ZiggleNoticeClient } from './ziggle-notice.client';
import { McpToolClient } from '../../../../mcp/mcp-tool-client';

function create(config: Record<string, unknown>) {
  return new ZiggleNoticeClient({
    get: (key: string) => config[key],
  } as never);
}

const CONFIGURED = {
  ZIGGLE_MCP_URL: 'https://api.ziggle.example/mcp',
  ZIGGLE_MCP_API_KEY: 'k'.repeat(32),
};

describe('ZiggleNoticeClient', () => {
  describe('isEnabledFor', () => {
    it('is off without MCP settings even for an allowed widget', () => {
      expect(
        create({ ZIGGLE_NOTICE_WIDGET_KEY_IDS: '*' }).isEnabledFor('w1'),
      ).toBe(false);
    });

    it('is off for every widget when no widget is listed', () => {
      expect(create(CONFIGURED).isEnabledFor('w1')).toBe(false);
    });

    it('is on only for listed widgets', () => {
      const client = create({
        ...CONFIGURED,
        ZIGGLE_NOTICE_WIDGET_KEY_IDS: ' w1 , w2 ',
      });
      expect(client.isEnabledFor('w2')).toBe(true);
      expect(client.isEnabledFor('w3')).toBe(false);
      expect(client.isEnabledFor(undefined)).toBe(false);
    });

    it('is on for every widget with *', () => {
      expect(
        create({
          ...CONFIGURED,
          ZIGGLE_NOTICE_WIDGET_KEY_IDS: '*',
        }).isEnabledFor('any'),
      ).toBe(true);
    });
  });

  it('builds notice links from the configured base', () => {
    expect(create({}).noticeUrl(5)).toBe('https://ziggle.gistory.me/notice/5');
    expect(
      create({
        ZIGGLE_NOTICE_URL_BASE: 'https://stg.ziggle.example/notice',
      }).noticeUrl(5),
    ).toBe('https://stg.ziggle.example/notice/5');
  });

  describe('MCP responses', () => {
    function mockCall(result: { text: string; isError: boolean }) {
      return jest
        .spyOn(McpToolClient.prototype, 'callTool')
        .mockResolvedValue(result);
    }

    it('parses search results and normalizes empty summaries', async () => {
      const spy = mockCall({
        text: JSON.stringify([
          { id: 1, title: '선발 안내', summary: '기간 10.1.~10.6.' },
          { id: 2, title: '요약 없음', summary: null },
          { id: 3, title: '빈 요약', summary: '  ' },
          { title: 'id 없음' },
        ]),
        isError: false,
      });

      await expect(
        create(CONFIGURED).searchNotices('선발', 8),
      ).resolves.toEqual([
        { id: 1, title: '선발 안내', summary: '기간 10.1.~10.6.' },
        { id: 2, title: '요약 없음', summary: null },
        { id: 3, title: '빈 요약', summary: null },
      ]);
      expect(spy).toHaveBeenCalledWith('search_notices', {
        query: '선발',
        limit: 8,
      });
      spy.mockRestore();
    });

    it('throws when the search tool reports an error', async () => {
      const spy = mockCall({ text: 'bad query', isError: true });
      await expect(create(CONFIGURED).searchNotices('x', 8)).rejects.toThrow(
        'bad query',
      );
      spy.mockRestore();
    });

    it('returns null for a notice the server cannot find', async () => {
      const spy = mockCall({ text: 'Notice 9 was not found.', isError: true });
      await expect(create(CONFIGURED).getNoticeBody(9)).resolves.toBeNull();
      spy.mockRestore();
    });

    it('returns the body of a found notice', async () => {
      const spy = mockCall({
        text: JSON.stringify({ id: 9, body: '<p>본문</p>' }),
        isError: false,
      });
      await expect(create(CONFIGURED).getNoticeBody(9)).resolves.toBe(
        '<p>본문</p>',
      );
      spy.mockRestore();
    });
  });
});
