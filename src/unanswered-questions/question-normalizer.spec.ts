import { describe, expect, it } from '@jest/globals';
import {
  detectQuestionLanguage,
  normalizeQuestion,
} from './question-normalizer';

describe('normalizeQuestion', () => {
  it('treats whitespace, case and trailing punctuation differences as the same question', () => {
    expect(normalizeQuestion('  부산에서   계좌 만들 수 있나요?? ')).toBe(
      '부산에서 계좌 만들 수 있나요',
    );
    expect(normalizeQuestion('How do I Apply?')).toBe(
      normalizeQuestion('how do i apply'),
    );
  });

  it('keeps punctuation inside the question', () => {
    expect(normalizeQuestion('A/B 반 중 어디?')).toBe('a/b 반 중 어디');
  });

  it('normalizes decomposed Hangul to NFC', () => {
    const decomposed = '학사'.normalize('NFD');
    expect(normalizeQuestion(decomposed)).toBe('학사');
  });
});

describe('detectQuestionLanguage', () => {
  it('detects Korean when any Hangul is present', () => {
    expect(detectQuestionLanguage('GIST 기숙사 신청 방법')).toBe('KO');
  });

  it('detects English for Latin-only questions', () => {
    expect(detectQuestionLanguage('Where is the library?')).toBe('EN');
  });

  it('falls back to OTHER', () => {
    expect(detectQuestionLanguage('图书馆在哪里')).toBe('OTHER');
  });
});
