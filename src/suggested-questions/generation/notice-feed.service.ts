import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ZiggleNoticeClient,
  type ZiggleNoticeSummary,
} from '../../chat/agent/tools/ziggle/ziggle-notice.client';

/**
 * 넓게 깔아 두는 씨드 키워드. 공지 제목·본문에 흔히 들어가는 단어로 고른다.
 * 안 잡히는 공지가 보이면 SUGGESTED_QUESTIONS_SEED_KEYWORDS로 재배포 없이 늘린다.
 */
export const DEFAULT_SEED_KEYWORDS = [
  '장학',
  '모집',
  '신청',
  '선발',
  '수강',
  '기숙사',
  '졸업',
  '행사',
  '채용',
  '등록금',
];

/** Ziggle search_notices가 받아 주는 limit 상한 */
export const ZIGGLE_SEARCH_MAX_LIMIT = 20;
export const DEFAULT_PER_KEYWORD_LIMIT = ZIGGLE_SEARCH_MAX_LIMIT;

/**
 * 지글에서 최근 공지를 긁어 오는 역할만 한다.
 *
 * Ziggle MCP에는 "최신 공지 목록" 도구가 없고 search_notices의 query가 필수다
 * (빈 문자열은 거부된다). 그래서 넓은 키워드 여러 개로 따로 검색해 id로 합친다.
 * 어떤 키워드에도 걸리지 않는 공지는 놓치므로 키워드는 설정으로 뺀다.
 */
@Injectable()
export class NoticeFeedService {
  private readonly logger = new Logger(NoticeFeedService.name);
  private readonly keywords: string[];
  private readonly perKeywordLimit: number;

  constructor(
    private readonly ziggle: ZiggleNoticeClient,
    configService: ConfigService,
  ) {
    const raw = configService
      .get<string>('SUGGESTED_QUESTIONS_SEED_KEYWORDS')
      ?.split(',')
      .map((keyword) => keyword.trim())
      .filter(Boolean);
    this.keywords = raw?.length ? raw : DEFAULT_SEED_KEYWORDS;

    const limit = Number(
      configService.get('SUGGESTED_QUESTIONS_PER_KEYWORD_LIMIT'),
    );
    this.perKeywordLimit =
      Number.isInteger(limit) && limit > 0
        ? Math.min(limit, ZIGGLE_SEARCH_MAX_LIMIT)
        : DEFAULT_PER_KEYWORD_LIMIT;
  }

  /**
   * 키워드별로 검색해 합친 공지 목록. id 내림차순(= 최신순)으로 돌려준다.
   *
   * 키워드 하나가 실패해도 나머지로 진행한다. 전부 실패하면 첫 오류를 던져
   * 워커가 백오프하게 한다.
   */
  async fetchRecent(signal?: AbortSignal): Promise<ZiggleNoticeSummary[]> {
    const settled = await Promise.allSettled(
      this.keywords.map((keyword) =>
        this.ziggle.searchNotices(keyword, this.perKeywordLimit, signal),
      ),
    );

    const lists: ZiggleNoticeSummary[][] = [];
    for (const [index, result] of settled.entries()) {
      if (result.status === 'fulfilled') {
        lists.push(result.value);
      } else {
        this.logger.warn(
          `Ziggle search failed for '${this.keywords[index]}': ${String(result.reason)}`,
        );
      }
    }
    if (lists.length === 0) {
      throw (settled[0] as PromiseRejectedResult).reason;
    }

    return dedupeByIdDesc(lists);
  }
}

/**
 * id로 중복을 제거하고 최신(큰 id)부터 정렬한다.
 *
 * search-notices.tool의 mergeByHits는 여러 키워드에 걸린 공지를 앞에 두는데,
 * 그건 사용자 질의에 대한 관련도 기준이다. 여기서 필요한 건 "최근에 올라온 것"이라
 * id 하나로만 정렬한다.
 */
export function dedupeByIdDesc(
  lists: ZiggleNoticeSummary[][],
): ZiggleNoticeSummary[] {
  const byId = new Map<number, ZiggleNoticeSummary>();
  for (const list of lists) {
    for (const notice of list) {
      if (!byId.has(notice.id)) byId.set(notice.id, notice);
    }
  }
  return [...byId.values()].sort((a, b) => b.id - a.id);
}
