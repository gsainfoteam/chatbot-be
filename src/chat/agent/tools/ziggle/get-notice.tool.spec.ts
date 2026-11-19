import { describe, expect, it, jest } from '@jest/globals';
import { GetNoticeTool } from './get-notice.tool';
import { noticeRegistry } from './notice-registry';
import type { AgentToolContext } from '../../agent.types';

function context(known: Record<number, string> = {}): AgentToolContext {
  const ctx: AgentToolContext = {
    catalog: { raw: {}, texts: [], resourceLinks: [], embeddedResources: [] },
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    seenPaths: new Set(),
    state: new Map(),
  };
  for (const [id, title] of Object.entries(known)) {
    noticeRegistry(ctx).set(Number(id), { title, summary: null });
  }
  return ctx;
}

function setup(body: string | null) {
  const ziggle = {
    getNoticeBody: jest.fn(async () => body),
    noticeUrl: (id: number) => `https://ziggle.example/notice/${id}`,
  };
  return { tool: new GetNoticeTool(ziggle as never), ziggle };
}

describe('GetNoticeTool', () => {
  it('only reads notices that a search returned', async () => {
    const { tool, ziggle } = setup('<p>본문</p>');

    const result = await tool.execute({ id: 999 }, context());

    expect(ziggle.getNoticeBody).not.toHaveBeenCalled();
    expect(result.resultCount).toBe(0);
    expect(result.content).toContain('search_notices 결과에 나온');
  });

  it('returns the body as plain text with an opened source', async () => {
    const { tool } = setup(
      '<div class="bd_detail_content"><p>신청 기간: 10.1.~10.6.</p><p>문의 010-1234-5678</p></div>',
    );

    const result = await tool.execute({ id: 7 }, context({ 7: '장학생 선발' }));

    expect(result.resultCount).toBe(1);
    expect(result.documents).toEqual([
      {
        path: 'ziggle-notice/7',
        sourceUrls: ['https://ziggle.example/notice/7'],
        content:
          '[Ziggle 공지] 장학생 선발\n원문 링크: https://ziggle.example/notice/7\n\n신청 기간: 10.1.~10.6.\n문의 [휴대전화 번호 가림]',
      },
    ]);
    expect(result.sources).toEqual([
      expect.objectContaining({ id: '7', opened: true }),
    ]);
  });

  it('tells the agent to use the summary when the body is only an image', async () => {
    const { tool } = setup('<p><img src="a.jpg"></p>');
    const ctx = context();
    noticeRegistry(ctx).set(7, {
      title: '장학 안내',
      summary: '기간 10.1.~10.6.',
    });

    const result = await tool.execute({ id: 7 }, ctx);

    expect(result.resultCount).toBe(0);
    expect(result.documents).toBeUndefined();
    expect(result.content).toContain('이미지로만');
  });

  it('keeps the title and link of an image-only notice without a summary', async () => {
    const { tool } = setup('<p><img src="a.jpg"></p>');

    const result = await tool.execute(
      { id: 7 },
      context({ 7: '인재림 장학생 모집' }),
    );

    expect(result.resultCount).toBe(0);
    expect(result.documents?.[0].content).toBe(
      '[Ziggle 공지] 인재림 장학생 모집\n원문 링크: https://ziggle.example/notice/7\n\n(본문이 이미지로만 되어 있어 내용을 확인할 수 없는 공지입니다. 세부 내용은 공지 원문에서 확인해야 합니다.)',
    );
    expect(result.sources).toEqual([
      expect.objectContaining({ id: '7', opened: true }),
    ]);
  });

  it('handles a notice that no longer exists', async () => {
    const { tool } = setup(null);

    const result = await tool.execute({ id: 7 }, context({ 7: '삭제된 공지' }));

    expect(result.resultCount).toBe(0);
    expect(result.content).toContain('찾을 수 없습니다');
  });

  it('labels steps with the known title', () => {
    const { tool } = setup(null);
    const ctx = context({ 7: '장학 안내' });
    expect(tool.describeStep({ id: 7 }, { status: 'running' }, ctx)).toBe(
      "'장학 안내' 공지를 읽고 있어요",
    );
    expect(
      tool.describeStep({ id: 7 }, { status: 'done', resultCount: 0 }, ctx),
    ).toBe("'장학 안내' 공지 본문을 읽지 못해 요약을 참고할게요");
    expect(tool.describeStep({ id: 8 }, { status: 'failed' }, ctx)).toBe(
      '공지 본문을 불러오지 못했어요',
    );
  });
});
