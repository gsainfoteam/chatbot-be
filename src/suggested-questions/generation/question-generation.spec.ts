import { describe, expect, it } from '@jest/globals';
import { SUGGESTED_QUESTION_MAX_LENGTH } from '../dto/suggested-question.dto';
import { parseGeneratedQuestions } from './question-generation.service';

const ONE =
  '[{"question":"국가장학금 언제까지 신청해요?","prompt":"기간을 안내한다"}]';

describe('parseGeneratedQuestions', () => {
  it('reads a plain JSON array', () => {
    expect(parseGeneratedQuestions(ONE)).toEqual([
      { question: '국가장학금 언제까지 신청해요?', prompt: '기간을 안내한다' },
    ]);
  });

  it('unwraps a markdown code fence', () => {
    // 프롬프트로 막아도 모델이 ```json 으로 감싸는 일이 잦다.
    const fenced = ['```json', ONE, '```'].join('\n');

    expect(parseGeneratedQuestions(fenced)).toHaveLength(1);
  });

  it('unwraps a fence without a language tag', () => {
    expect(
      parseGeneratedQuestions(['```', ONE, '```'].join('\n')),
    ).toHaveLength(1);
  });

  it('treats an empty array as a notice with nothing to ask', () => {
    expect(parseGeneratedQuestions('[]')).toEqual([]);
  });

  it('returns nothing instead of throwing on malformed JSON', () => {
    expect(parseGeneratedQuestions('질문을 만들 수 없습니다')).toEqual([]);
    expect(parseGeneratedQuestions('[{"question":')).toEqual([]);
    expect(parseGeneratedQuestions('')).toEqual([]);
  });

  it('ignores a JSON value that is not an array', () => {
    expect(parseGeneratedQuestions('{"question":"x","prompt":"y"}')).toEqual(
      [],
    );
  });

  it('drops items with a missing or non-string field', () => {
    const raw = JSON.stringify([
      { question: '정상 질문이에요?', prompt: '지침' },
      { question: '프롬프트 없음' },
      { prompt: '질문 없음' },
      { question: 123, prompt: '지침' },
      null,
      '문자열 항목',
    ]);

    expect(parseGeneratedQuestions(raw)).toEqual([
      { question: '정상 질문이에요?', prompt: '지침' },
    ]);
  });

  it('drops blank and whitespace-only fields', () => {
    const raw = JSON.stringify([
      { question: '   ', prompt: '지침' },
      { question: '질문', prompt: '   ' },
    ]);

    expect(parseGeneratedQuestions(raw)).toEqual([]);
  });

  it('trims surrounding whitespace', () => {
    const raw = JSON.stringify([
      { question: '  질문이에요?  ', prompt: ' 지침 ' },
    ]);

    expect(parseGeneratedQuestions(raw)).toEqual([
      { question: '질문이에요?', prompt: '지침' },
    ]);
  });

  it('drops a question longer than the column allows', () => {
    // DB의 check 제약에 걸리면 INSERT가 통째로 실패하므로 여기서 버려야 한다.
    const raw = JSON.stringify([
      {
        question: '가'.repeat(SUGGESTED_QUESTION_MAX_LENGTH + 1),
        prompt: '지침',
      },
      { question: '가'.repeat(SUGGESTED_QUESTION_MAX_LENGTH), prompt: '지침' },
    ]);

    const parsed = parseGeneratedQuestions(raw);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].question).toHaveLength(SUGGESTED_QUESTION_MAX_LENGTH);
  });

  it('keeps only the first of two questions that differ by punctuation', () => {
    const raw = JSON.stringify([
      { question: '장학금 언제 신청해요?', prompt: '첫 번째' },
      { question: '장학금 언제 신청해요', prompt: '두 번째' },
    ]);

    expect(parseGeneratedQuestions(raw)).toEqual([
      { question: '장학금 언제 신청해요?', prompt: '첫 번째' },
    ]);
  });
});
