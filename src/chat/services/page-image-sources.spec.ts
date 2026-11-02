import { describe, expect, it } from '@jest/globals';
import {
  extractPageImages,
  selectPageImageResources,
  stripPageImageReferences,
} from './page-image-sources';

describe('stripPageImageReferences', () => {
  it('leaves only the description for the answering LLM', () => {
    expect(stripPageImageReferences('본문\n\n![절차도](IMAGE:page-2)')).toBe(
      '본문\n\n절차도',
    );
  });
});

describe('extractPageImages', () => {
  it('maps a reference to the stored image of the chunk document', () => {
    const [image] = extractPageImages(
      '신청서를 제출합니다\n\n![절차도](IMAGE:page-2)',
      '기숙사 안내/입사/절차',
    );

    expect(image.objectPath).toBe('기숙사 안내/images/page-2.jpg');
    expect(image.description).toBe('절차도');
    expect(image.context).toContain('신청서를 제출합니다');
  });

  it('takes context only from text since the previous reference', () => {
    const images = extractPageImages(
      '첫째 쪽\n\n![가](IMAGE:page-1)\n\n둘째 쪽\n\n![나](IMAGE:page-2)',
      '문서',
    );

    expect(images[1].context).toContain('둘째 쪽');
    expect(images[1].context).not.toContain('첫째 쪽');
  });

  it('returns nothing for a chunk without references', () => {
    expect(extractPageImages('본문', '문서')).toEqual([]);
  });
});

describe('selectPageImageResources', () => {
  const dormitory = {
    objectPath: '안내/images/page-1.jpg',
    description: '기숙사 입사 안내',
    context: '기숙사 보증금은 150,000원이며 퇴사 시 환불됩니다',
  };
  const library = {
    objectPath: '안내/images/page-2.jpg',
    description: '도서관 안내',
    context: '도서관 연체료는 하루 1권당 100원입니다',
  };

  it('picks the image whose page text the answer uses', () => {
    const resources = selectPageImageResources(
      '보증금은 150,000원이고 퇴사 시 환불됩니다.',
      '보증금 얼마예요?',
      [library, dormitory],
    );

    expect(resources.map((r) => r.path)).toEqual(['기숙사 입사 안내']);
  });

  it('ranks a page that says the answer above a long page that mentions it', () => {
    const shortPage = {
      objectPath: '안내/images/page-8.jpg',
      description: '아이폰 모바일카드 태그 방법',
      context: '아이폰은 NFC 사용이 불가하여 블루투스 방식만 사용 가능',
    };
    const longPage = {
      objectPath: '안내/images/page-7.jpg',
      description: '모바일카드 사용 방법',
      context:
        '아이폰은 NFC를 쓸 수 없고 블루투스 방식만 사용 가능합니다. 앱은 플레이스토어에서 검색하여 내려받고, 안드로이드 운영체제 4.4 이상이면 근거리 무선통신 기능을 켭니다. 스크린을 깨운 뒤 전용 어플을 실행하고 리더에 접촉하면 문이 열립니다. 발급 대기 중인 카드가 있으면 휴대폰 인증 화면으로 이동합니다.',
    };

    const resources = selectPageImageResources(
      '아이폰은 NFC를 쓸 수 없고 블루투스 방식만 사용 가능합니다.',
      '아이폰 NFC 되나요?',
      [longPage, shortPage],
    );

    expect(resources[0].path).toBe(shortPage.description);
  });

  it('leaves out a long page that shares only the subject of the answer', () => {
    const dns = {
      objectPath: '공유기/images/page-5.jpg',
      description: '공유기 네트워크 정보 입력',
      context: '기본 DNS 주소 203.237.32.100 보조 DNS 주소 203.237.32.101 고정',
    };
    const ports = {
      objectPath: '공유기/images/page-2.jpg',
      description: '공유기 포트 연결 안내',
      context: `기숙사 공유기의 기본 주소는 호실별로 다르며 게시판에 있습니다. ${'벽면 아울렛에 랜선을 연결하고 외부회선 포트에 꽂습니다. '.repeat(8)}`,
    };

    const resources = selectPageImageResources(
      '기숙사 공유기의 기본 DNS 주소는 203.237.32.100입니다.',
      '기숙사 공유기 기본 DNS 주소가 뭐예요?',
      [ports, dns],
    );

    expect(resources.map((r) => r.path)).toEqual([dns.description]);
  });

  it('builds a JPEG resource with each path segment encoded', () => {
    const [resource] = selectPageImageResources(
      '보증금은 150,000원입니다',
      '보증금',
      [dormitory],
    );

    expect(resource.formats).toEqual(['jpg']);
    expect(resource.url).toBe(
      `${encodeURIComponent('안내')}/images/page-1.jpg`,
    );
  });

  it('shows no image when the answer has nothing to do with it', () => {
    expect(
      selectPageImageResources('셔틀버스는 8시에 출발합니다', '셔틀 시간', [
        library,
      ]),
    ).toEqual([]);
  });

  it('shows a page without text when the question names it', () => {
    const map = {
      objectPath: '캠퍼스맵/images/page-1.jpg',
      description: '지스트_캠퍼스맵_건물_위치 1쪽',
      context: '',
    };

    const resources = selectPageImageResources(
      '캠퍼스는 W, S, C 구역으로 나뉩니다.',
      '캠퍼스맵 보여줘',
      [map],
    );

    expect(resources).toHaveLength(1);
  });

  it('returns at most two images', () => {
    const pages = [1, 2, 3].map((page) => ({
      ...dormitory,
      objectPath: `안내/images/page-${page}.jpg`,
    }));

    expect(
      selectPageImageResources(dormitory.context, '보증금', pages),
    ).toHaveLength(2);
  });

  it('leaves out an image far weaker than the best match', () => {
    const cover = {
      objectPath: '안내/images/page-9.jpg',
      description: '기숙사',
      context: '',
    };

    const resources = selectPageImageResources(
      dormitory.context,
      '기숙사 보증금',
      [cover, dormitory],
    );

    expect(resources.map((r) => r.path)).toEqual(['기숙사 입사 안내']);
  });

  it('counts an image found in several chunks once', () => {
    expect(
      selectPageImageResources(dormitory.context, '보증금', [
        dormitory,
        dormitory,
      ]),
    ).toHaveLength(1);
  });

  it('matches text regardless of Unicode normalization', () => {
    const nfd = {
      ...dormitory,
      description: dormitory.description.normalize('NFD'),
      context: dormitory.context.normalize('NFD'),
    };

    expect(
      selectPageImageResources(dormitory.context, '보증금', [nfd]),
    ).toHaveLength(1);
  });
});
