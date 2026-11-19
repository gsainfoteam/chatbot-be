import { describe, expect, it, jest } from '@jest/globals';
import { SearchWebTool } from './search-web.tool';
import type { WebFinding } from './grounded-findings';
import type { AgentToolContext } from '../../agent.types';

const context = (): AgentToolContext => ({
  catalog: { raw: {}, texts: [], resourceLinks: [], embeddedResources: [] },
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  seenPaths: new Set(),
  state: new Map(),
});

function setup(findings: WebFinding[] | Error) {
  const webSearch = {
    search: jest.fn(async () => {
      if (findings instanceof Error) throw findings;
      return { findings, queries: [] };
    }),
  };
  return { tool: new SearchWebTool(webSearch as never), webSearch };
}

const official = {
  url: 'https://dorm.gist.ac.kr/rule',
  domain: 'dorm.gist.ac.kr',
  official: true,
  resolved: true,
};
const blog = {
  url: 'https://blog.example.com/a',
  domain: 'blog.example.com',
  official: false,
  resolved: true,
};

describe('SearchWebTool', () => {
  it('returns grounded sentences as a web document with sources, official first', async () => {
    const { tool } = setup([
      { text: '외박 신청은 전날까지 한다.', sources: [blog] },
      { text: '생활관 시스템에서 신청한다.', sources: [official] },
    ]);

    const result = await tool.execute({ query: 'GIST 기숙사 외박' }, context());

    expect(result.resultCount).toBe(2);
    expect(result.documents?.[0].content).toBe(
      "[웹 검색] 'GIST 기숙사 외박' 검색 결과\n" +
        '- 외박 신청은 전날까지 한다. (출처: [blog.example.com](https://blog.example.com/a))\n' +
        '- 생활관 시스템에서 신청한다. (출처: [dorm.gist.ac.kr](https://dorm.gist.ac.kr/rule), 공식)',
    );
    // 에이전트에게는 긴 URL 없이 도메인만 보여준다.
    expect(result.content).toContain('(출처: dorm.gist.ac.kr, 공식)');
    expect(result.content).not.toContain('https://');
    expect(result.sources?.map((source) => source.url)).toEqual([
      official.url,
      blog.url,
    ]);
    expect(result.sources?.[0]).toMatchObject({
      kind: 'web',
      title: 'dorm.gist.ac.kr',
    });
  });

  it('cites an unresolved redirect link by domain only, without a link', async () => {
    const redirect = {
      url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc',
      domain: 'etnews.com',
      official: false,
      resolved: false,
    };
    const { tool } = setup([
      { text: '철학 교육을 강화한다.', sources: [redirect] },
    ]);

    const result = await tool.execute({ query: 'GIST 철학' }, context());

    expect(result.documents?.[0].content).toContain(
      '- 철학 교육을 강화한다. (출처: etnews.com)',
    );
    expect(result.documents?.[0].content).not.toContain('vertexaisearch');
  });

  it('masks personal numbers in findings', async () => {
    const { tool } = setup([
      { text: '문의 010-1234-5678', sources: [official] },
    ]);

    const result = await tool.execute({ query: 'GIST 문의' }, context());

    expect(result.documents?.[0].content).toContain('[휴대전화 번호 가림]');
  });

  it('tells the agent to stop searching the web when nothing is grounded', async () => {
    const { tool } = setup([]);

    const result = await tool.execute({ query: 'GIST 학식' }, context());

    expect(result.resultCount).toBe(0);
    expect(result.documents).toBeUndefined();
    expect(result.content).toContain('반복하지 말고');
  });

  it('lets search failures surface as a failed step', async () => {
    const { tool } = setup(new Error('timeout'));

    await expect(tool.execute({ query: 'GIST' }, context())).rejects.toThrow(
      'timeout',
    );
  });

  it('labels each stage with the right particle', () => {
    const { tool } = setup([]);
    expect(
      tool.describeStep({ query: 'GIST 기숙사' }, { status: 'running' }),
    ).toBe("웹에서 'GIST 기숙사'를 찾고 있어요");
    expect(
      tool.describeStep({ query: '기말고사 기간' }, { status: 'running' }),
    ).toBe("웹에서 '기말고사 기간'을 찾고 있어요");
    expect(
      tool.describeStep({ query: 'q' }, { status: 'done', resultCount: 3 }),
    ).toBe('웹에서 관련 내용 3건을 찾았어요');
    expect(
      tool.describeStep({ query: 'q' }, { status: 'done', resultCount: 0 }),
    ).toBe('웹에서 근거 있는 내용을 찾지 못했어요');
  });
});
