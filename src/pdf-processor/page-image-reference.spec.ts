import { describe, expect, it } from '@jest/globals';
import {
  appendPageImageReference,
  hasNoTextLayer,
  hasPageImageReference,
  MIN_READING_AGREEMENT,
  normalizeImageReferences,
  pageImageObjectPath,
  readingAgreement,
  readingsDisagree,
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

  it('keeps only the first of repeated references', () => {
    expect(
      normalizeImageReferences('![가](IMAGE:page-3)\n![나](IMAGE:page-3)', 3),
    ).toBe('![가](IMAGE:page-3)\n나');
  });

  it('keeps only the description of other image syntax', () => {
    expect(normalizeImageReferences('![로고](logo.png)', 3)).toBe('로고');
  });

  it('keeps only descriptions for a page without a stored image', () => {
    expect(normalizeImageReferences('![절차도](IMAGE:page-3)', null)).toBe(
      '절차도',
    );
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

  it('returns only the reference for a page without text', () => {
    expect(appendPageImageReference('', 'doc.pdf', 2)).toBe(
      '![doc 2쪽](IMAGE:page-2)',
    );
  });

  it('removes brackets that would break the reference', () => {
    expect(appendPageImageReference('', '[붙임1] 공고.pdf', 1)).toBe(
      '![붙임1 공고 1쪽](IMAGE:page-1)',
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

describe('readingsDisagree', () => {
  const FIRST =
    '학생회관 도서관 기숙사 연구개발관 전자공학관 생명과학관 예술관 정보통신관 인공지능관 창업관 기계공학부 전자공학부 한국사무소 바이오디자인센터 융합연구센터 창의융합센터 연구개발센터 창업지원센터 카페테리아 학생식당 헬스장 세미나실 강의실 연구실 실험실 회의실 휴게실 자습실 안내소';
  const SECOND =
    '오룡관 국제관 대학원기숙사 기혼자아파트 어린이집 교수사택 내빈관 시설관리동 창업진흥동 중앙창고 크리에이티브공간 기계로봇동 행정동 금호동 신소재동 환경에너지동 다산빌딩 중앙기기소 폐수처리장 동물자원소 산학협력관 고등광기술원 자연과학동 플랜트 어린이회관 수영장 테니스코트 축구장 야구장';

  it('flags long readings that made up different content', () => {
    expect(readingsDisagree(FIRST.repeat(2), SECOND.repeat(2))).toBe(true);
  });

  it('accepts long readings that say the same thing', () => {
    expect(readingsDisagree(FIRST.repeat(2), FIRST.repeat(2))).toBe(false);
  });

  it('leaves short descriptions alone, which rarely repeat word for word', () => {
    expect(
      readingsDisagree('성적표 제출 예시입니다', '공식 증명서를 내세요'),
    ).toBe(false);
  });
});

describe('readingAgreement', () => {
  it('is 1 for identical readings', () => {
    expect(
      readingAgreement('## 수강신청\n\n19학점', '## 수강신청\n\n19학점'),
    ).toBe(1);
  });

  it('ignores differences in markdown formatting', () => {
    const list = '- **W1**: 오룡관\n- **W2**: 체육관\n- **W3**: 국제관';
    const table = '| W1 | 오룡관 |\n| W2 | 체육관 |\n| W3 | 국제관 |';

    expect(readingAgreement(list, table)).toBeGreaterThanOrEqual(
      MIN_READING_AGREEMENT,
    );
  });

  it('ignores image references', () => {
    expect(
      readingAgreement('본문입니다\n\n![가](IMAGE:page-1)', '본문입니다'),
    ).toBe(1);
  });

  it('falls below the threshold when labels are made up differently', () => {
    const first =
      '- W1: 학생회관\n- W2: 도서관\n- W3: 기숙사\n- W5: 연구개발관';
    const second =
      '- W1: 창의관\n- W2: 예술대학\n- W3: 기계공학부\n- W5: 생명과학';

    expect(readingAgreement(first, second)).toBeLessThan(MIN_READING_AGREEMENT);
  });

  it('treats two empty readings as agreeing', () => {
    expect(readingAgreement('', '  ')).toBe(1);
  });

  it('is 0 when only one reading has text', () => {
    expect(readingAgreement('본문입니다', '')).toBe(0);
  });
});
