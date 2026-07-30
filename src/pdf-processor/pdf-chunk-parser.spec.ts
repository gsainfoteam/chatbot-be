import { describe, expect, it } from '@jest/globals';
import { parseChunksFromMarkdown, toResourceName } from './pdf-chunk-parser';

describe('parseChunksFromMarkdown', () => {
  it('parses summary and document tags', () => {
    const input = `
<summary>문서 요약</summary>

# 제목

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
      { path: '테스트/섹션-a', description: '설명 A' },
      { path: '테스트/섹션-b', description: '설명 B' },
    ]);
    expect(documents['테스트/섹션-a.md']).toContain('내용 A');
    expect(documents['테스트/섹션-b.md']).toContain('내용 B');
    expect(documents['테스트.md']).toContain('path="테스트/섹션-a"');
  });

  it('falls back to single md when no document tags', () => {
    const input = '<summary>요약만</summary>\n\n# 본문';
    const { documents, metadata } = parseChunksFromMarkdown(input, 'alone.pdf');
    expect(metadata.description).toBe('요약만');
    expect(metadata.chunks).toEqual([]);
    expect(documents['alone.md']).toContain('# 본문');
  });
});

describe('toResourceName', () => {
  it('strips pdf extension and NFC-normalizes', () => {
    expect(toResourceName('안내.pdf')).toBe('안내');
    expect(toResourceName('folder/문서.PDF')).toBe('문서');
  });
});
