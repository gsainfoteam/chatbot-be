import { describe, expect, it } from '@jest/globals';
import {
  buildCanonicalEmbeddingText,
  hashEmbeddingContent,
} from './embedding-text';
import { MAX_EMBEDDING_INPUT_BYTES } from './embedding.constants';

describe('canonical embedding text', () => {
  const chunk = {
    documentTitle: '  학사편람  ',
    documentSummary: '졸업\r\n안내',
    path: '학사편람/졸업요건',
    description: ' 졸업 요건 ',
    content: '본문\r\n내용',
  };

  it('is deterministic across line endings and surrounding whitespace', () => {
    const first = buildCanonicalEmbeddingText(chunk);
    const second = buildCanonicalEmbeddingText({
      ...chunk,
      documentTitle: '학사편람',
      documentSummary: '졸업\n안내',
      description: '졸업 요건',
      content: '본문\n내용',
    });

    expect(first).toBe(second);
    expect(hashEmbeddingContent(first)).toBe(hashEmbeddingContent(second));
    expect(hashEmbeddingContent(first)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('includes every required field and safely caps large content', () => {
    const text = buildCanonicalEmbeddingText({
      ...chunk,
      content: '한'.repeat(MAX_EMBEDDING_INPUT_BYTES),
    });

    expect(text).toContain('Document title:\n학사편람');
    expect(text).toContain('Document summary:\n졸업\n안내');
    expect(text).toContain('Chunk path:\n학사편람/졸업요건');
    expect(text).toContain('Chunk description:\n졸업 요건');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(
      MAX_EMBEDDING_INPUT_BYTES,
    );
    expect(text).not.toContain('\uFFFD');
  });
});
