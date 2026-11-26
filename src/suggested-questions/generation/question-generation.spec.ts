import { describe, expect, it } from '@jest/globals';
import { SUGGESTED_QUESTION_MAX_LENGTH } from '../dto/suggested-question.dto';
import {
  MAX_KEYWORDS,
  MAX_KEYWORD_CHARS,
  keywordsFoundInBody,
  parseGeneratedQuestions,
} from './question-generation.service';
import { buildAnswerPrompt } from './question-generation.prompt';

const ONE =
  '[{"question":"국가장학금 언제까지 신청해요?","keywords":["국가장학금"]}]';

describe('parseGeneratedQuestions', () => {
  it('reads a plain JSON array', () => {
    expect(parseGeneratedQuestions(ONE)).toEqual([
      {
        question: '국가장학금 언제까지 신청해요?',
        keywords: ['국가장학금'],
      },
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
    expect(
      parseGeneratedQuestions('{"question":"x","keywords":["y"]}'),
    ).toEqual([]);
  });

  it('drops items with a missing or non-string question', () => {
    const raw = JSON.stringify([
      { question: '정상 질문이에요?', keywords: ['장학'] },
      { keywords: ['질문 없음'] },
      { question: 123, keywords: ['장학'] },
      null,
      '문자열 항목',
    ]);

    expect(parseGeneratedQuestions(raw)).toEqual([
      { question: '정상 질문이에요?', keywords: ['장학'] },
    ]);
  });

  it('keeps an item without keywords so the body check can drop it later', () => {
    const raw = JSON.stringify([
      { question: '질문이에요?' },
      { question: '다른 질문이에요?', keywords: 'C동' },
    ]);

    expect(parseGeneratedQuestions(raw).map((q) => q.keywords)).toEqual([
      [],
      [],
    ]);
  });

  it('drops a blank or whitespace-only question', () => {
    const raw = JSON.stringify([{ question: '   ', keywords: ['장학'] }]);

    expect(parseGeneratedQuestions(raw)).toEqual([]);
  });

  it('trims surrounding whitespace and non-string keywords', () => {
    const raw = JSON.stringify([
      {
        question: '  질문이에요?  ',
        keywords: [' 지네마 ', '', 3, null],
      },
    ]);

    expect(parseGeneratedQuestions(raw)).toEqual([
      { question: '질문이에요?', keywords: ['지네마'] },
    ]);
  });

  it('drops a question longer than the column allows', () => {
    // DB의 check 제약에 걸리면 INSERT가 통째로 실패하므로 여기서 버려야 한다.
    const raw = JSON.stringify([
      {
        question: '가'.repeat(SUGGESTED_QUESTION_MAX_LENGTH + 1),
      },
      { question: '가'.repeat(SUGGESTED_QUESTION_MAX_LENGTH) },
    ]);

    const parsed = parseGeneratedQuestions(raw);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].question).toHaveLength(SUGGESTED_QUESTION_MAX_LENGTH);
  });

  it('keeps only the first of two questions that differ by punctuation', () => {
    const raw = JSON.stringify([
      { question: '장학금 언제 신청해요?', keywords: ['첫 번째'] },
      { question: '장학금 언제 신청해요', keywords: ['두 번째'] },
    ]);

    expect(parseGeneratedQuestions(raw).map((q) => q.keywords)).toEqual([
      ['첫 번째'],
    ]);
  });
});

describe('keywordsFoundInBody', () => {
  const BODY =
    '2026 겨울행사 지네마를 진행합니다. 일시: 11월 27일 오후 8시, 장소: 대학 C동 104호. HRL 세미나도 함께';

  it('keeps only keywords that appear in the body verbatim', () => {
    // 지글 검색은 본문 부분일치라 띄어쓰기 하나만 달라도 걸리지 않는다.
    expect(
      keywordsFoundInBody(
        ['지네마', '겨울 행사', '겨울행사', '크리스마스'],
        BODY,
      ),
    ).toEqual(['지네마', '겨울행사']);
  });

  it('matches case-insensitively like the Ziggle search', () => {
    expect(keywordsFoundInBody(['hrl', 'c동'], BODY)).toEqual(['hrl', 'c동']);
  });

  it('drops duplicates and caps the count', () => {
    expect(
      keywordsFoundInBody(
        ['지네마', '지네마', '겨울행사', 'C동', '104호'],
        BODY,
      ),
    ).toHaveLength(MAX_KEYWORDS);
    expect(keywordsFoundInBody(['지네마', '지네마'], BODY)).toEqual(['지네마']);
  });

  it('drops a keyword longer than the search tool accepts', () => {
    const long = BODY.slice(0, MAX_KEYWORD_CHARS + 1);

    expect(keywordsFoundInBody([long], BODY)).toEqual([]);
  });

  it('returns nothing when no keyword is in the body', () => {
    expect(keywordsFoundInBody(['장학금'], BODY)).toEqual([]);
  });
});

describe('buildAnswerPrompt', () => {
  const params = {
    noticeId: 200992,
    noticeTitle: '[GIST 학생창업동아리 MOP] 2026 MOP 데모데이 안내',
    keywords: ['MOP', '데모데이'],
    question: '2026 MOP 데모데이는 언제 어디서 열리나요?',
  };

  it('puts the question first, then asks to find it in the notice', () => {
    // 카드에 마우스를 올리면 이 문장이 그대로 보인다. 사용자가 부탁하는 말투여야 한다.
    expect(buildAnswerPrompt(params)).toBe(
      [
        '2026 MOP 데모데이는 언제 어디서 열리나요?',
        '',
        "GIST 지글 공지 「[GIST 학생창업동아리 MOP] 2026 MOP 데모데이 안내」(공지 번호 200992)에서 'MOP', '데모데이' 키워드를 기반으로 찾아주세요.",
      ].join('\n'),
    );
  });

  it('does not instruct the agent to call tools', () => {
    // 범위 판정이 도구를 시키는 문장을 조작 시도로 보고 거절한다.
    const prompt = buildAnswerPrompt(params);

    expect(prompt).not.toMatch(/search_notices|get_notice|검색하면|읽고 답해/);
  });

  it('leaves out the title when the notice has none', () => {
    const prompt = buildAnswerPrompt({ ...params, noticeTitle: '  ' });

    expect(prompt.split('\n')[2]).toBe(
      "GIST 지글 공지(공지 번호 200992)에서 'MOP', '데모데이' 키워드를 기반으로 찾아주세요.",
    );
  });
});
