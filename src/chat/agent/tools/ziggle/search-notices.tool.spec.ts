import { describe, expect, it, jest } from '@jest/globals';
import { SearchNoticesTool, mergeByHits } from './search-notices.tool';
import type { ZiggleNoticeSummary } from './ziggle-notice.client';
import { noticeRegistry } from './notice-registry';
import type { AgentToolContext } from '../../agent.types';

function context(): AgentToolContext {
  return {
    catalog: { raw: {}, texts: [], resourceLinks: [], embeddedResources: [] },
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    seenPaths: new Set(),
    state: new Map(),
  };
}

const notice = (
  id: number,
  title: string,
  summary: string | null = `${title} 요약`,
): ZiggleNoticeSummary => ({ id, title, summary });

function setup(byKeyword: Record<string, ZiggleNoticeSummary[] | Error>) {
  const ziggle = {
    searchNotices: jest.fn(async (query: string, _limit: number) => {
      const result = byKeyword[query] ?? [];
      if (result instanceof Error) throw result;
      return result;
    }),
    noticeUrl: (id: number) => `https://ziggle.example/notice/${id}`,
  };
  return { tool: new SearchNoticesTool(ziggle as never), ziggle };
}

describe('SearchNoticesTool', () => {
  it('searches each keyword separately and puts notices matching more keywords first', async () => {
    const { tool, ziggle } = setup({
      장학생: [notice(10, '장학생 선발'), notice(12, '장학생 간담회')],
      선발: [notice(10, '장학생 선발'), notice(11, '조교 선발')],
    });

    const result = await tool.execute(
      { keywords: ['장학생', '선발'] },
      context(),
    );

    expect(ziggle.searchNotices).toHaveBeenCalledWith('장학생', 8);
    expect(ziggle.searchNotices).toHaveBeenCalledWith('선발', 8);
    expect(result.resultCount).toBe(3);
    expect(result.content.indexOf('[id=10]')).toBeLessThan(
      result.content.indexOf('[id=12]'),
    );
  });

  it('drops blank and duplicate keywords', async () => {
    const { tool, ziggle } = setup({});

    await tool.execute(
      { keywords: ['장학생', ' 장학 생 ', '', 3, '선발'] },
      context(),
    );

    expect(ziggle.searchNotices.mock.calls.map(([query]) => query)).toEqual([
      '장학생',
      '선발',
    ]);
  });

  it('keeps going when only some keyword searches fail', async () => {
    const { tool } = setup({
      장학생: [notice(10, '장학생 선발')],
      선발: new Error('timeout'),
    });

    const result = await tool.execute(
      { keywords: ['장학생', '선발'] },
      context(),
    );

    expect(result.resultCount).toBe(1);
  });

  it('throws when every keyword search fails so the step shows as failed', async () => {
    const { tool } = setup({ 장학생: new Error('down') });

    await expect(
      tool.execute({ keywords: ['장학생'] }, context()),
    ).rejects.toThrow('down');
  });

  it('remembers found notices and returns summaries as documents with sources', async () => {
    const { tool } = setup({
      장학: [notice(10, '장학생 선발'), notice(9, '요약 없는 공지', null)],
    });
    const ctx = context();

    const result = await tool.execute({ keywords: ['장학'] }, ctx);

    expect(noticeRegistry(ctx).get(9)).toEqual({
      title: '요약 없는 공지',
      summary: null,
    });
    expect(result.documents).toEqual([
      {
        path: 'ziggle-notice/10/summary',
        content: '[Ziggle 공지] 장학생 선발\n요약: 장학생 선발 요약',
      },
    ]);
    expect(result.sources).toEqual([
      {
        kind: 'notice',
        id: '10',
        title: '장학생 선발',
        url: 'https://ziggle.example/notice/10',
        opened: false,
      },
    ]);
    expect(result.content).toContain('요약 없음. 필요하면 get_notice');
  });

  it('masks personal numbers in summaries', async () => {
    const { tool } = setup({
      장학: [notice(10, '선발 결과', '문의 010-1234-5678')],
    });

    const result = await tool.execute({ keywords: ['장학'] }, context());

    expect(result.content).toContain('[휴대전화 번호 가림]');
    expect(result.documents?.[0].content).not.toContain('010-1234-5678');
  });

  it('suggests other words when nothing matches', async () => {
    const { tool } = setup({});

    const result = await tool.execute({ keywords: ['학식'] }, context());

    expect(result.resultCount).toBe(0);
    expect(result.documents).toBeUndefined();
    expect(result.content).toContain('다른 단어');
  });

  it('labels each stage', () => {
    const { tool } = setup({});
    const args = { keywords: ['장학생', '선발'] };
    expect(tool.describeStep(args, { status: 'running' })).toBe(
      "Ziggle에서 '장학생', '선발' 공지를 찾고 있어요",
    );
    expect(tool.describeStep(args, { status: 'done', resultCount: 4 })).toBe(
      'Ziggle 공지 4개를 불러왔어요',
    );
    expect(tool.describeStep(args, { status: 'done', resultCount: 0 })).toBe(
      'Ziggle에서 관련 공지를 찾지 못했어요',
    );
  });
});

describe('mergeByHits', () => {
  it('breaks ties by putting the newer (larger id) notice first', () => {
    expect(
      mergeByHits([[notice(1, 'a'), notice(3, 'c')], [notice(2, 'b')]]).map(
        (n) => n.id,
      ),
    ).toEqual([3, 2, 1]);
  });
});
