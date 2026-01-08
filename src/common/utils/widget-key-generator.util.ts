import { nanoid } from 'nanoid';

/**
 * 위젯 키 생성 유틸리티
 * wk_live_ 접두사 + nanoid 형식의 고유 키를 생성합니다
 */

const WIDGET_KEY_PREFIX = 'wk_live_';
const KEY_LENGTH = 24; // nanoid 부분의 길이

/**
 * 고유한 위젯 키를 생성합니다
 * @returns 생성된 위젯 키 (예: wk_live_abc123xyz789...)
 */
export function generateWidgetKey(): string {
  const uniqueId = nanoid(KEY_LENGTH);
  return `${WIDGET_KEY_PREFIX}${uniqueId}`;
}

/**
 * 위젯 키 형식이 올바른지 검증합니다
 * @param key - 검증할 위젯 키
 * @returns 유효 여부
 */
export function isValidWidgetKeyFormat(key: string): boolean {
  if (!key || typeof key !== 'string') {
    return false;
  }

  // 접두사 확인
  if (!key.startsWith(WIDGET_KEY_PREFIX)) {
    return false;
  }

  // 전체 길이 확인
  const expectedLength = WIDGET_KEY_PREFIX.length + KEY_LENGTH;
  if (key.length !== expectedLength) {
    return false;
  }

  // nanoid 부분은 영숫자와 일부 특수문자(-_)만 포함
  const nanoidPart = key.substring(WIDGET_KEY_PREFIX.length);
  const nanoidRegex = /^[A-Za-z0-9_-]+$/;
  return nanoidRegex.test(nanoidPart);
}
