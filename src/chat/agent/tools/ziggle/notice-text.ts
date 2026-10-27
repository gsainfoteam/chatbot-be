/**
 * Ziggle 공지 본문(크롤링한 학사공지 HTML) 정리.
 * 의존성 없이 공지 본문에 흔한 태그(p, br, table, li)만 다룬다.
 */

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  middot: '·',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (match, entity: string) => {
      if (entity[0] === '#') {
        const code =
          entity[1].toLowerCase() === 'x'
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    },
  );
}

/** HTML → 읽을 수 있는 평문. 표는 셀을 ` | `로 이어 한 행을 한 줄로 만든다. */
export function htmlToPlainText(html: string): string {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<\/(p|div|tr|h[1-6]|table|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  return decodeEntities(text)
    .split('\n')
    .map((line) =>
      line
        .replace(/[ \t\u00a0]+/g, ' ')
        .replace(/\s*\|\s*$/, '')
        .trim(),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 본문에 이미지가 있는지. 평문이 비었을 때 "이미지 본문"인지 구분하려고 쓴다. */
export function hasImage(html: string): boolean {
  return /<img\b/i.test(html);
}

const RESIDENT_NUMBER = /\b\d{6}\s?-\s?[1-4]\d{6}\b/g;
const MOBILE_NUMBER = /\b01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}\b/g;
const STUDENT_ID = /\b(?:19|20)\d{6}\b/g;
/** 학번이 이 개수 이상 나오면 명단으로 보고 가린다. 한두 개는 날짜·문서번호일 수 있다. */
const STUDENT_ID_LIST_THRESHOLD = 3;

/**
 * LLM에 넘기기 전에 개인을 특정할 수 있는 번호를 가린다.
 * 담당 부서 연락처(지역번호 전화, 이메일)는 답변에 필요한 정보라 남긴다.
 */
export function maskPersonalInfo(text: string): string {
  let masked = text
    .replace(RESIDENT_NUMBER, '[주민등록번호 가림]')
    .replace(MOBILE_NUMBER, '[휴대전화 번호 가림]');
  const studentIds = masked.match(STUDENT_ID) ?? [];
  if (studentIds.length >= STUDENT_ID_LIST_THRESHOLD) {
    masked = masked.replace(STUDENT_ID, '[학번 가림]');
  }
  return masked;
}
