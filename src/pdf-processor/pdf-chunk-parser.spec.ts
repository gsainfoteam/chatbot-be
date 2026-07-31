import { describe, expect, it } from '@jest/globals';
import {
  parseChunksFromMarkdown,
  toRelativeChunkPath,
  toResourceName,
} from './pdf-chunk-parser';

describe('toRelativeChunkPath', () => {
  it('keeps relative paths', () => {
    expect(toRelativeChunkPath('섹션-a', '테스트')).toBe('섹션-a');
    expect(toRelativeChunkPath('a/b', '테스트')).toBe('a/b');
  });

  it('strips a single baseName prefix', () => {
    expect(toRelativeChunkPath('테스트/섹션-a', '테스트')).toBe('섹션-a');
  });

  it('strips duplicated baseName prefixes', () => {
    expect(toRelativeChunkPath('테스트/테스트/섹션-a', '테스트')).toBe(
      '섹션-a',
    );
  });

  it('returns empty when path is only the baseName', () => {
    expect(toRelativeChunkPath('테스트', '테스트')).toBe('');
  });
});

describe('parseChunksFromMarkdown', () => {
  it('parses summary, preserves overview, and normalizes relative paths', () => {
    const input = `
<summary>문서 요약</summary>

# 제목

소개 문단입니다.

<document path="섹션-a" description="설명 A">
## 섹션 A
내용 A
</document>

<document path="섹션-b" description="설명 B">
## 섹션 B
내용 B
</document>
`;
    const { documents, metadata } = parseChunksFromMarkdown(
      input,
      '테스트.pdf',
    );

    expect(metadata.description).toBe('문서 요약');
    expect(metadata.chunks).toEqual([
      { path: '테스트', description: '문서 요약' },
      { path: '테스트/섹션-a', description: '설명 A' },
      { path: '테스트/섹션-b', description: '설명 B' },
    ]);
    expect(documents['테스트/섹션-a.md']).toContain('내용 A');
    expect(documents['테스트/섹션-b.md']).toContain('내용 B');
    expect(documents['테스트.md']).toContain('소개 문단입니다.');
    expect(documents['테스트.md']).toContain('path="테스트/섹션-a"');
  });

  it('deduplicates baseName already present in LLM paths', () => {
    const input = `
<summary>요약</summary>
# 개요

<document path="테스트/섹션-a" description="A">본문 A</document>
<document path="테스트/테스트/섹션-b" description="B">본문 B</document>
`;
    const { documents, metadata } = parseChunksFromMarkdown(
      input,
      '테스트.pdf',
    );

    expect(metadata.chunks.map((c) => c.path)).toEqual([
      '테스트',
      '테스트/섹션-a',
      '테스트/섹션-b',
    ]);
    expect(documents['테스트/섹션-a.md']).toBe('본문 A');
    expect(documents['테스트/섹션-b.md']).toBe('본문 B');
  });

  it('omits root chunk when there is no overview outside document tags', () => {
    const input = `
<summary>요약만</summary>
<document path="섹션-a" description="A">본문</document>
`;
    const { documents, metadata } = parseChunksFromMarkdown(
      input,
      '테스트.pdf',
    );

    expect(metadata.chunks).toEqual([
      { path: '테스트/섹션-a', description: 'A' },
    ]);
    expect(documents['테스트.md']).toContain('path="테스트/섹션-a"');
    expect(documents['테스트/섹션-a.md']).toBe('본문');
  });

  it('falls back to single md when no document tags', () => {
    const input = '<summary>요약만</summary>\n\n# 본문';
    const { documents, metadata } = parseChunksFromMarkdown(input, 'alone.pdf');
    expect(metadata.description).toBe('요약만');
    expect(metadata.chunks).toEqual([]);
    expect(documents['alone.md']).toContain('# 본문');
    expect(documents['alone.md']).not.toContain('<summary>');
  });
});

describe('toResourceName', () => {
  it('strips pdf extension and NFC-normalizes', () => {
    expect(toResourceName('안내.pdf')).toBe('안내');
    expect(toResourceName('folder/문서.PDF')).toBe('문서');
  });
});
