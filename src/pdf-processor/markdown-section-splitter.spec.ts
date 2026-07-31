import { describe, expect, it } from '@jest/globals';
import {
  CHUNK_MAX_CHARS,
  CHUNK_MIN_CHARS,
  splitMarkdownIntoSections,
} from './markdown-section-splitter';

function pad(label: string, size: number): string {
  const unit = `${label} 내용 `;
  return unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
}

describe('splitMarkdownIntoSections', () => {
  it('merges several short ## sections toward target size', () => {
    const markdown = [
      '# 문서',
      '',
      `## A\n\n${pad('A', 1_500)}`,
      '',
      `## B\n\n${pad('B', 1_500)}`,
      '',
      `## C\n\n${pad('C', 1_500)}`,
    ].join('\n');

    const sections = splitMarkdownIntoSections(markdown);
    expect(sections.length).toBeLessThan(3);
    expect(sections[0].content).toContain('## A');
    expect(sections[0].content).toContain('## B');
  });

  it('keeps small ### subsections inside their parent ## chunk', () => {
    const markdown = [
      `## 수강신청\n\n${pad('intro', 800)}`,
      '',
      `### 신청기간\n\n${pad('기간', 800)}`,
      '',
      `### 신청방법\n\n${pad('방법', 800)}`,
    ].join('\n');

    const sections = splitMarkdownIntoSections(markdown);
    expect(sections).toHaveLength(1);
    expect(sections[0].content).toContain('### 신청기간');
    expect(sections[0].content).toContain('### 신청방법');
  });

  it('splits an oversized ## section by ### boundaries', () => {
    const markdown = [
      `## 큰섹션\n\n${pad('intro', 500)}`,
      '',
      `### 파트1\n\n${pad('p1', CHUNK_MAX_CHARS / 2)}`,
      '',
      `### 파트2\n\n${pad('p2', CHUNK_MAX_CHARS / 2)}`,
    ].join('\n');

    const sections = splitMarkdownIntoSections(markdown);
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.every((s) => s.content.includes('## 큰섹션'))).toBe(true);
    expect(sections.some((s) => s.content.includes('### 파트1'))).toBe(true);
    expect(sections.some((s) => s.content.includes('### 파트2'))).toBe(true);
  });

  it('splits a long section without headings by length', () => {
    const markdown = pad('plain', CHUNK_MAX_CHARS * 2 + 100);
    const sections = splitMarkdownIntoSections(markdown);
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.every((s) => s.content.length <= CHUNK_MAX_CHARS)).toBe(
      true,
    );
  });

  it('does not treat # headings as split boundaries', () => {
    const markdown = [
      `# 제목\n\n${pad('intro', 500)}`,
      '',
      `## 본문\n\n${pad('body', CHUNK_MIN_CHARS)}`,
    ].join('\n');

    const sections = splitMarkdownIntoSections(markdown);
    expect(sections.length).toBeGreaterThanOrEqual(1);
    // preamble before first ## becomes its own section (or merges), but `#` alone
    // does not create many tiny chunks.
    expect(sections.length).toBeLessThanOrEqual(2);
  });
});
