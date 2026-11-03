import { describe, expect, it } from '@jest/globals';
import {
  appendPageImageReference,
  hasNoTextLayer,
  hasPageImageReference,
  normalizeImageReferences,
  pageImageObjectPath,
} from './page-image-reference';

describe('pageImageObjectPath', () => {
  it('places the image under the document prefix', () => {
    expect(pageImageObjectPath('문서', 3)).toBe('문서/images/page-3.jpg');
  });
});

describe('normalizeImageReferences', () => {
  it('keeps a reference to the given page', () => {
    const markdown = '본문\n\n![절차도](IMAGE:page-3)';

    expect(normalizeImageReferences(markdown, 3)).toBe(markdown);
  });

  it('keeps only the description of a reference to another page', () => {
    expect(normalizeImageReferences('![절차도](IMAGE:page-6)', 3)).toBe(
      '절차도',
    );
  });

  it('rewrites a description with brackets so readers can parse it', () => {
    expect(
      normalizeImageReferences('![[붙임1] 공고 지도](IMAGE:page-3)', 3),
    ).toBe('![붙임1 공고 지도](IMAGE:page-3)');
  });

  it('rewrites a target with spaces so readers can parse it', () => {
    expect(normalizeImageReferences('![지도]( IMAGE:page-3 )', 3)).toBe(
      '![지도](IMAGE:page-3)',
    );
  });

  it('leaves brackets and parentheses in the text alone', () => {
    const markdown = '[붙임1] 공고 (참고)\n\n![지도](IMAGE:page-3)';

    expect(normalizeImageReferences(markdown, 3)).toBe(markdown);
  });

  it('keeps only the description of other image syntax', () => {
    expect(normalizeImageReferences('![로고](logo.png)', 3)).toBe('로고');
  });

  it('keeps only descriptions for a page without a stored image', () => {
    expect(normalizeImageReferences('![절차도](IMAGE:page-3)', null)).toBe(
      '절차도',
    );
  });

  it('stays fast on text full of unclosed references', () => {
    const started = Date.now();
    normalizeImageReferences('![]( '.repeat(3_000), 3);

    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('hasPageImageReference', () => {
  it('finds a reference only for its own page', () => {
    expect(hasPageImageReference('![가](IMAGE:page-3)', 3)).toBe(true);
    expect(hasPageImageReference('![가](IMAGE:page-3)', 30)).toBe(false);
  });
});

describe('appendPageImageReference', () => {
  it('adds the reference as its own paragraph', () => {
    expect(appendPageImageReference('본문', 'doc.pdf', 2)).toBe(
      '본문\n\n![doc 2쪽](IMAGE:page-2)',
    );
  });

  it('removes brackets that would break the reference', () => {
    expect(appendPageImageReference('본문', '[붙임1] 공고.pdf', 1)).toBe(
      '본문\n\n![붙임1 공고 1쪽](IMAGE:page-1)',
    );
  });
});

describe('hasNoTextLayer', () => {
  it('counts a page number as no text', () => {
    expect(hasNoTextLayer(' 45 ')).toBe(true);
  });

  it('counts a short title as text', () => {
    expect(hasNoTextLayer('공유기 네트워크 설정방법')).toBe(false);
  });
});
