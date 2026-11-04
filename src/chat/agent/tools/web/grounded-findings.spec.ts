import { describe, expect, it, jest } from '@jest/globals';
import {
  extractFindings,
  matchesDomain,
  resolveGroundingUrl,
} from './grounded-findings';
import type { GoogleSearchGrounding } from '../../../types/llm.types';

const REDIRECT = (id: string) =>
  `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${id}`;

describe('matchesDomain', () => {
  it('matches the domain itself, www, and subdomains', () => {
    expect(matchesDomain('gist.ac.kr', ['gist.ac.kr'])).toBe(true);
    expect(matchesDomain('www.gist.ac.kr', ['gist.ac.kr'])).toBe(true);
    expect(matchesDomain('dorm.gist.ac.kr', ['gist.ac.kr'])).toBe(true);
  });

  it('does not match look-alike domains', () => {
    expect(matchesDomain('notgist.ac.kr', ['gist.ac.kr'])).toBe(false);
    expect(matchesDomain('gist.ac.kr.evil.com', ['gist.ac.kr'])).toBe(false);
  });
});

describe('resolveGroundingUrl', () => {
  it('reads the original address from the redirect Location', async () => {
    const fetchImpl = jest.fn(async () => ({
      headers: new Headers({ location: 'https://www.gist.ac.kr/kr/main.html' }),
    })) as unknown as typeof fetch;

    await expect(
      resolveGroundingUrl(REDIRECT('a'), 1000, fetchImpl),
    ).resolves.toBe('https://www.gist.ac.kr/kr/main.html');
    expect(fetchImpl).toHaveBeenCalledWith(
      REDIRECT('a'),
      expect.objectContaining({ method: 'HEAD', redirect: 'manual' }),
    );
  });

  it('keeps a non-redirect address as it is without a request', async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;

    await expect(
      resolveGroundingUrl('https://example.com/a', 1000, fetchImpl),
    ).resolves.toBe('https://example.com/a');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null when the redirect cannot be resolved', async () => {
    const failing = jest.fn(async () => {
      throw new Error('timeout');
    }) as unknown as typeof fetch;
    const noLocation = jest.fn(async () => ({
      headers: new Headers(),
    })) as unknown as typeof fetch;

    await expect(
      resolveGroundingUrl(REDIRECT('a'), 1000, failing),
    ).resolves.toBeNull();
    await expect(
      resolveGroundingUrl(REDIRECT('a'), 1000, noLocation),
    ).resolves.toBeNull();
    await expect(resolveGroundingUrl('not a url', 1000)).resolves.toBeNull();
  });
});

describe('extractFindings', () => {
  const grounding: GoogleSearchGrounding = {
    queries: ['GIST 기숙사 통금 시간'],
    chunks: [
      { uri: REDIRECT('0'), title: 'gist.ac.kr' },
      { uri: REDIRECT('1'), title: 'reddit.com' },
      { uri: REDIRECT('2'), title: 'gistnews.co.kr' },
    ],
    supports: [
      { text: 'GIST 생활관은 통금이 없다.', chunkIndices: [0, 2] },
      { text: '한국 대학 기숙사는 보통 밤 11시에 닫는다.', chunkIndices: [1] },
      { text: '근거 없는 문장', chunkIndices: [] },
    ],
  };
  const resolved = [
    'https://dorm.gist.ac.kr/rule',
    'https://www.reddit.com/r/korea/1',
    null,
  ];

  it('keeps only sentences backed by a source', () => {
    const findings = extractFindings(grounding, resolved, {
      allowedDomains: [],
      officialDomains: ['gist.ac.kr'],
    });

    expect(findings.map((finding) => finding.text)).toEqual([
      'GIST 생활관은 통금이 없다.',
      '한국 대학 기숙사는 보통 밤 11시에 닫는다.',
    ]);
  });

  it('marks official sources and lists them first', () => {
    const [first] = extractFindings(grounding, resolved, {
      allowedDomains: [],
      officialDomains: ['gist.ac.kr'],
    });

    expect(first.sources).toEqual([
      {
        url: 'https://dorm.gist.ac.kr/rule',
        domain: 'dorm.gist.ac.kr',
        official: true,
        resolved: true,
      },
    ]);
  });

  it('never trusts an unresolved redirect title for an allowed domain', () => {
    expect(
      extractFindings(
        {
          queries: [],
          chunks: [{ uri: REDIRECT('fake'), title: 'gist.ac.kr' }],
          supports: [{ text: '잘못된 근거', chunkIndices: [0] }],
        },
        [null],
        { allowedDomains: ['gist.ac.kr'], officialDomains: ['gist.ac.kr'] },
      ),
    ).toEqual([]);
  });

  it('drops sentences whose sources are all outside the allowed domains', () => {
    const findings = extractFindings(grounding, resolved, {
      allowedDomains: ['gist.ac.kr'],
      officialDomains: ['gist.ac.kr'],
    });

    expect(findings).toEqual([
      {
        text: 'GIST 생활관은 통금이 없다.',
        sources: [
          {
            url: 'https://dorm.gist.ac.kr/rule',
            domain: 'dorm.gist.ac.kr',
            official: true,
            resolved: true,
          },
        ],
      },
    ]);
  });

  it('drops sentences that only say nothing was found, and trims leading punctuation and markdown', () => {
    const findings = extractFindings(
      {
        queries: [],
        chunks: [{ uri: 'https://gistnews.co.kr/a', title: 'gistnews.co.kr' }],
        supports: [
          {
            text: 'GIST 기숙사의 통금 시간에 대한 명확한 정보는 검색 결과에서 찾을 수 없습니다.',
            chunkIndices: [0],
          },
          { text: '셔틀버스 시간표는 알 수 없습니다.', chunkIndices: [0] },
          {
            text: ', 2018년 신입생 캠프에서 통금이 언급됐다.',
            chunkIndices: [0],
          },
          {
            text: '*   **LG도서관:** 오전 9시부터 오후 9시까지 운영된다.',
            chunkIndices: [0],
          },
        ],
      },
      ['https://gistnews.co.kr/a'],
      { allowedDomains: [], officialDomains: ['gist.ac.kr'] },
    );

    expect(findings.map((finding) => finding.text)).toEqual([
      '2018년 신입생 캠프에서 통금이 언급됐다.',
      'LG도서관: 오전 9시부터 오후 9시까지 운영된다.',
    ]);
  });
});
