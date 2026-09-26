export type QuestionLanguage = 'KO' | 'EN' | 'OTHER';

const TRAILING_PUNCTUATION_RE = /[\s?!.。？！~…]+$/u;
const HANGUL_RE = /[\p{Script=Hangul}]/u;
const LATIN_RE = /[A-Za-z]/;

/**
 * 같은 질문의 반복 여부를 판단하기 위한 키.
 * 대소문자·공백·끝 문장부호 차이만 흡수하고 의미 단위 정규화는 하지 않는다.
 */
export function normalizeQuestion(question: string): string {
  return question
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(TRAILING_PUNCTUATION_RE, '');
}

export function detectQuestionLanguage(question: string): QuestionLanguage {
  if (HANGUL_RE.test(question)) return 'KO';
  if (LATIN_RE.test(question)) return 'EN';
  return 'OTHER';
}
