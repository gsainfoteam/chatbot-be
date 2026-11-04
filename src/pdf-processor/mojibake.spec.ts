import { describe, expect, it } from '@jest/globals';
import {
  isLikelyMojibake,
  tryFixMojibake,
  normalizeExtractedText,
  removeLoneSurrogates,
} from './mojibake';
import iconv from 'iconv-lite';

describe('lone surrogates from broken font mappings', () => {
  it('removes them because the LLM gateway rejects a request with them', () => {
    expect(removeLoneSurrogates('지글 앱\uDFA7 설치\uDB24')).toBe(
      '지글 앱 설치',
    );
  });

  it('keeps characters outside the basic plane intact', () => {
    expect(removeLoneSurrogates('안내 😀 끝')).toBe('안내 😀 끝');
  });
});

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
