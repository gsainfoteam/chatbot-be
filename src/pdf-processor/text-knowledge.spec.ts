import { describe, expect, it } from '@jest/globals';
import {
  buildTextKnowledgeMarkdown,
  toTextResourceName,
} from './text-knowledge';

describe('toTextResourceName', () => {
  it('keeps the title as the resource name', () => {
    expect(toTextResourceName('  유학생 은행 계좌 개설 안내 ')).toBe(
      '유학생 은행 계좌 개설 안내',
    );
  });

  it('replaces path separators so chunk paths stay under one resource', () => {
    expect(toTextResourceName('입사/퇴사 절차\\안내')).toBe(
      '입사-퇴사 절차-안내',
    );
  });

  it('keeps a .pdf-looking title distinct from the PDF resource name', () => {
    expect(toTextResourceName('규정.pdf')).toBe('규정-pdf');
  });

  it('replaces dots so extension stripping cannot truncate the name', () => {
    expect(toTextResourceName('학칙 v2.1')).toBe('학칙 v2-1');
  });
});

describe('buildTextKnowledgeMarkdown', () => {
  it('prefixes the title as a context heading', () => {
    expect(buildTextKnowledgeMarkdown(' 계좌 개설 ', '\n본문\n')).toBe(
      '# 계좌 개설\n\n본문',
    );
  });
});
