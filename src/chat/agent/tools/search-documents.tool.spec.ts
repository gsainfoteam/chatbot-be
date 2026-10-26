import { describe, expect, it } from '@jest/globals';
import {
  SearchDocumentsTool,
  describeDocumentsForAgent,
  withRo,
} from './search-documents.tool';

describe('withRo', () => {
  it.each([
    ['학식', '으로'],
    ['졸업 요건', '으로'],
    ['휴학', '으로'],
    ['장학금', '으로'],
    ['수강 신청', '으로'],
    ['교과 과정', '으로'],
    ['학사 일정 문의', '로'],
    ['학칙', '으로'],
    ['규칙', '으로'],
    ['교환학생 서류', '로'],
    ['휴학 절차', '로'],
    ['기숙사 규칙', '으로'],
    ['GIST', '(으)로'],
    ['2026', '(으)로'],
  ])('%s → %s', (word, particle) => {
    expect(withRo(word)).toBe(particle);
  });

  it('treats a final ㄹ like no final consonant', () => {
    expect(withRo('학생회 신청 서류 제출일')).toBe('로');
    expect(withRo('휴학 규정 제출 방법')).toBe('으로');
  });
});

describe('SearchDocumentsTool.describeStep', () => {
  const tool = new SearchDocumentsTool({} as never);

  it('labels each stage of a search', () => {
    const args = { query: '졸업 요건' };
    expect(tool.describeStep(args, { status: 'running' })).toBe(
      "'졸업 요건' 문서를 찾고 있어요",
    );
    expect(tool.describeStep(args, { status: 'done', resultCount: 3 })).toBe(
      "'졸업 요건' 관련 문서 3개를 찾았어요",
    );
    expect(tool.describeStep(args, { status: 'done', resultCount: 0 })).toBe(
      "'졸업 요건'으로는 문서를 찾지 못했어요",
    );
    expect(tool.describeStep(args, { status: 'failed' })).toBe(
      "'졸업 요건' 문서 검색에 실패했어요",
    );
  });

  it('shortens a long query in the label', () => {
    const label = tool.describeStep(
      { query: '가'.repeat(50) },
      { status: 'running' },
    );
    expect(label).toBe(`'${'가'.repeat(30)}…' 문서를 찾고 있어요`);
  });
});

describe('describeDocumentsForAgent', () => {
  it('skips bodies the agent has already seen', () => {
    const content = describeDocumentsForAgent(
      [
        { path: 'A/1', content: '첫 본문' },
        { path: 'B/1', content: '새 본문' },
      ],
      new Set(['A/1']),
    );
    expect(content).toContain('### B/1\n새 본문');
    expect(content).not.toContain('첫 본문');
    expect(content).toContain('이미 확인한 문서 1개는 생략');
  });
});
