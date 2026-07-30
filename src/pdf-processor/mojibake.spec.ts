import { describe, expect, it } from '@jest/globals';
import {
  isLikelyMojibake,
  tryFixMojibake,
  normalizeExtractedText,
} from './mojibake';
import iconv from 'iconv-lite';

describe('mojibake', () => {
  it('detects Korean UTF-8 misdecoded as latin1', () => {
    const original = '학사 일정';
    const mojibake = iconv.decode(Buffer.from(original, 'utf8'), 'latin1');
    expect(isLikelyMojibake(mojibake)).toBe(true);
    expect(tryFixMojibake(mojibake)).toBe(original);
    expect(normalizeExtractedText(mojibake)).toBe(original);
  });

  it('leaves normal Korean text unchanged', () => {
    const text = '정상적인 한글 텍스트입니다';
    expect(isLikelyMojibake(text)).toBe(false);
    expect(normalizeExtractedText(text)).toBe(text);
  });
});
