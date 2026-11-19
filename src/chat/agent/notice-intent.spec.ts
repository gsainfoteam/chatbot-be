import { describe, expect, it } from '@jest/globals';
import { hasNoticeIntent } from './notice-intent';

describe('hasNoticeIntent', () => {
  it.each([
    '이번 학기 장학금 신청 언제까지야?',
    '교환학생 모집 공고 나왔어?',
    '계절학기 수강신청 기간 알려줘',
    '중간고사 시간표 바뀌었어?',
    '2026 하계 계절학기',
    '2학기 휴강 일정',
    '9월 18일에 뭐 있어?',
  ])('treats "%s" as needing notices', (question) => {
    expect(hasNoticeIntent(question)).toBe(true);
  });

  it.each([
    '졸업 요건 학점 알려줘',
    '휴학하려면 어떻게 해?',
    '전과 조건이 뭐야?',
    '도서관 위치 알려줘',
  ])('answers "%s" from documents only', (question) => {
    expect(hasNoticeIntent(question)).toBe(false);
  });
});
