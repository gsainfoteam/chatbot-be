import type { GoogleSearchGrounding } from '../../../types/llm.types';

/** 구글 그라운딩 출처 링크(리다이렉트)의 호스트 */
const GROUNDING_REDIRECT_HOST = 'vertexaisearch.cloud.google.com';
/** 한 번의 검색에서 남기는 사실 수와 길이 상한 */
const MAX_FINDINGS = 8;
const MAX_FINDING_CHARS = 300;

/**
 * "검색 결과에서 찾을 수 없습니다"처럼 정보가 없다는 문장. 그라운딩은 이런 문장에도 출처를 붙이는데,
 * 그 출처는 대개 질문과 무관한 페이지라 사실로 남기면 엉뚱한 링크만 늘어난다.
 */
const ABSENCE_SENTENCE =
  /(찾을|확인할|알)\s*수\s*없|찾지\s*못|(정보|결과|내용|자료)\S{0,2}\s*없(?!이)|검색\s*결과\s*없음|명확하지\s*않|공개되지\s*않/;

export type DomainPolicy = {
  /** 비어 있으면 모든 도메인 허용 */
  allowedDomains: readonly string[];
  /** 학교 공식 출처로 표시할 도메인 */
  officialDomains: readonly string[];
};

export type WebSourceRef = {
  url: string;
  domain: string;
  official: boolean;
  /**
   * 실제 주소로 풀었는지. 못 풀었으면 url은 구글 리다이렉트 링크다.
   * 리다이렉트 링크는 시간이 지나면 만료되므로 답변 본문의 링크로는 쓰지 않는다.
   */
  resolved: boolean;
};

export type WebFinding = { text: string; sources: WebSourceRef[] };

/** `gist.ac.kr`은 `www.gist.ac.kr`, `academic.gist.ac.kr`도 포함한다. */
export function matchesDomain(
  domain: string,
  candidates: readonly string[],
): boolean {
  const host = domain.toLowerCase().replace(/^www\./, '');
  return candidates.some((candidate) => {
    const target = candidate
      .toLowerCase()
      .trim()
      .replace(/^www\./, '');
    return target !== '' && (host === target || host.endsWith(`.${target}`));
  });
}

/**
 * 그라운딩 출처 링크를 실제 주소로 바꾼다. 구글 리다이렉트는 302 Location에 원래 주소를 담는다.
 * 실패하면 null이며, 호출부는 리다이렉트 링크를 그대로 쓴다(브라우저에서는 열린다).
 */
export async function resolveGroundingUrl(
  uri: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    return null;
  signal?.throwIfAborted();
  if (parsed.hostname !== GROUNDING_REDIRECT_HOST) return uri;
  try {
    const response = await fetchImpl(uri, {
      method: 'HEAD',
      redirect: 'manual',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
    const location = response.headers.get('location');
    return location && /^https?:\/\//i.test(location) ? location : null;
  } catch {
    return null;
  }
}

/** 출처 주소에서 도메인을 뽑는다. 주소를 못 풀었으면 그라운딩 제목(보통 도메인)을 쓴다. */
function domainOf(url: string | null, title: string): string {
  if (url) {
    try {
      const host = new URL(url).hostname;
      if (host !== GROUNDING_REDIRECT_HOST) return host.replace(/^www\./, '');
    } catch {
      // 제목으로 대신한다.
    }
  }
  return title.trim().toLowerCase();
}

/**
 * 그라운딩 결과에서 근거가 있는 문장만 남긴다.
 * - 근거 출처가 없는 문장(모델이 덧붙인 일반 지식)은 버린다.
 * - 허용 도메인 밖의 출처만 근거인 문장도 버린다.
 */
export function extractFindings(
  grounding: GoogleSearchGrounding,
  resolvedUrls: ReadonlyArray<string | null>,
  policy: DomainPolicy,
): WebFinding[] {
  const refs = grounding.chunks.map((chunk, index): WebSourceRef | null => {
    // Unresolved redirect titles are not proof of a domain; exclude them from citations and evidence.
    const url = resolvedUrls[index];
    if (!url) return null;
    try {
      const parsed = new URL(url);
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.hostname === GROUNDING_REDIRECT_HOST
      )
        return null;
    } catch {
      return null;
    }
    const domain = domainOf(resolvedUrls[index] ?? null, chunk.title);
    if (!url || !domain) return null;
    if (
      policy.allowedDomains.length > 0 &&
      !matchesDomain(domain, policy.allowedDomains)
    ) {
      return null;
    }
    return {
      url,
      domain,
      official: matchesDomain(domain, policy.officialDomains),
      resolved: resolvedUrls[index] != null,
    };
  });

  const findings: WebFinding[] = [];
  const seenTexts = new Set<string>();
  for (const support of grounding.supports) {
    // 문장 조각이 ", 2014년에는…"처럼 이어지는 문장부호나 "*   **중앙도서관:**" 같은 마크다운으로
    // 시작하는 경우가 있다. 최종 답변 자료에서는 평문 한 줄로 쓴다.
    const text = support.text
      .replace(/\*\*/g, '')
      .replace(/^[\s,.;:·*\-•]+/, '')
      .trim();
    if (!text || ABSENCE_SENTENCE.test(text) || seenTexts.has(text)) continue;
    const sources = support.chunkIndices
      .map((index) => refs[index])
      .filter((ref): ref is WebSourceRef => ref != null);
    if (sources.length === 0) continue;
    seenTexts.add(text);
    findings.push({
      text: text.slice(0, MAX_FINDING_CHARS),
      sources: dedupeByUrl(sources).sort(
        (a, b) => Number(b.official) - Number(a.official),
      ),
    });
    if (findings.length >= MAX_FINDINGS) break;
  }
  return findings;
}

function dedupeByUrl(refs: WebSourceRef[]): WebSourceRef[] {
  const byUrl = new Map<string, WebSourceRef>();
  for (const ref of refs) if (!byUrl.has(ref.url)) byUrl.set(ref.url, ref);
  return [...byUrl.values()];
}
