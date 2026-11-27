/**
 * 진행 문구에 검색어·제목을 넣을 때 붙이는 조사.
 * 마지막 글자의 받침으로 고르고, 한글로 끝나지 않으면 읽는 법을 알 수 없어 둘을 함께 쓴다.
 */

const HANGUL_SYLLABLE_START = 0xac00;
const HANGUL_SYLLABLE_COUNT = 11172;
/** 종성 인덱스 8 = ㄹ */
const FINAL_RIEUL = 8;

/** 마지막 글자의 종성 인덱스(0 = 받침 없음). 한글 음절이 아니면 null */
function finalConsonant(word: string): number | null {
  const code = word.charCodeAt(word.length - 1) - HANGUL_SYLLABLE_START;
  if (Number.isNaN(code) || code < 0 || code >= HANGUL_SYLLABLE_COUNT) {
    return null;
  }
  return code % 28;
}

/** "로/으로". 받침이 있으면(ㄹ 제외) "으로", 없으면 "로" */
export function withRo(word: string): string {
  const jong = finalConsonant(word);
  if (jong === null) return '(으)로';
  return jong === 0 || jong === FINAL_RIEUL ? '로' : '으로';
}

/** "을/를". 받침이 있으면 "을", 없으면 "를" */
export function withEulReul(word: string): string {
  const jong = finalConsonant(word);
  if (jong === null) return '을(를)';
  return jong === 0 ? '를' : '을';
}
