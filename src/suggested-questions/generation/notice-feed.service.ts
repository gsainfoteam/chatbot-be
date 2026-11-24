import { Injectable, Logger } from '@nestjs/common';
import {
  ZiggleNoticeClient,
  type ZiggleNoticeSummary,
} from '../../chat/agent/tools/ziggle/ziggle-notice.client';

/**
 * 최신 공지 목록을 받아 오기 위한 질의어.
 *
 * Ziggle MCP에는 목록 도구가 없고 `search_notices`의 query가 필수다. 그런데
 * ziggle-be의 구현(apps/api/src/mcp/mcp.service.ts)을 보면 이렇다.
 *
 *   where:   { deletedAt: null, plainBody: { contains: query, mode: 'insensitive' } }
 *   orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }]
 *   take:    limit
 *
 * 즉 **각 질의는 최신순**이고, 본문에 그 문자열이 들어간 공지를 걸러 줄 뿐이다.
 * 그래서 거의 모든 본문에 들어가는 짧은 문자열을 쓰면 사실상 "최신 목록"이 된다.
 * 주제어(장학, 기숙사 …)를 쓰면 그 주제의 공지만 걸려 수집이 편향된다.
 *
 * 한국어 종결어미 '다'가 가장 넓고, 영어만 쓰인 공지를 위해 'a'·'e'를, 날짜·연도가
 * 들어간 공지를 위해 '1'을 둔다. 합집합을 쓰므로 하나가 놓쳐도 다른 것이 덮는다.
 *
 * staging 실측(2026-11-24): 이 다섯 개(각 limit 50)로 최신 60개 id 구간에서
 * 본문이 있는 44건을 **전부** 포착했다. 놓친 것 0건.
 *
 * 걸리지 않는 공지는 `plainBody`가 빈 것, 곧 본문이 이미지뿐인 공지다.
 * 그런 공지는 어차피 질문을 만들 수 없어 생성 단계에서 건너뛴다.
 */
export const BROAD_QUERIES = ['다', '의', 'a', 'e', '1'];

/** Ziggle search_notices가 받아 주는 limit 상한 */
export const ZIGGLE_SEARCH_MAX_LIMIT = 50;

/**
 * 질의 하나당 받아 올 건수. 상한을 그대로 쓴다.
 * 서버가 최신순으로 잘라 주므로 많이 받을수록 더 과거까지 덮는다.
 */
export const PER_QUERY_LIMIT = ZIGGLE_SEARCH_MAX_LIMIT;

/**
 * 지글에서 최근 공지를 가져온다.
 *
 * 질의 몇 개를 합쳐 최신순 목록을 만든다. 각 질의가 서버에서 이미 최신순으로
 * 정렬돼 오므로 id 내림차순으로 합치기만 하면 된다.
 *
 * 요청한 건수가 합집합보다 많으면(백필) 가장 큰 id부터 아래로 번호를 채운다.
 * 공지 id는 학사·자치를 가리지 않는 하나의 증가 수열이라 내려가며 세면 빠짐이 없다.
 * 중간에 없는 id는 삭제된 공지(`deletedAt`)이고, 생성 단계에서 본문을 못 읽어
 * 자연히 걸러진다.
 */
@Injectable()
export class NoticeFeedService {
  private readonly logger = new Logger(NoticeFeedService.name);

  constructor(private readonly ziggle: ZiggleNoticeClient) {}

  /** 최신 `limit`건을 id 내림차순으로 돌려준다. */
  async fetchRecent(
    limit: number,
    signal?: AbortSignal,
  ): Promise<ZiggleNoticeSummary[]> {
    const found = await this.search(signal);
    if (found.size === 0) {
      throw new Error('Ziggle search returned nothing; cannot locate notices');
    }

    const newestFirst = [...found.values()].sort((a, b) => b.id - a.id);
    const notices =
      newestFirst.length >= limit
        ? newestFirst.slice(0, limit)
        : this.padWithIds(newestFirst, limit);

    this.logger.log(
      `최신 공지 ${notices.length}건 (id ${notices[notices.length - 1]?.id}~${notices[0]?.id}), ` +
        `제목 확보 ${notices.filter((n) => n.title).length}건`,
    );
    return notices;
  }

  /** 질의들을 합쳐 id -> 공지 맵을 만든다. 하나가 실패해도 나머지로 진행한다. */
  private async search(
    signal?: AbortSignal,
  ): Promise<Map<number, ZiggleNoticeSummary>> {
    const settled = await Promise.allSettled(
      BROAD_QUERIES.map((query) =>
        this.ziggle.searchNotices(query, PER_QUERY_LIMIT, signal),
      ),
    );

    const found = new Map<number, ZiggleNoticeSummary>();
    let ok = 0;
    for (const [index, result] of settled.entries()) {
      if (result.status === 'fulfilled') {
        ok += 1;
        for (const notice of result.value) {
          if (!found.has(notice.id)) found.set(notice.id, notice);
        }
      } else {
        this.logger.warn(
          `Ziggle search failed for '${BROAD_QUERIES[index]}': ${String(result.reason)}`,
        );
      }
    }
    if (ok === 0) {
      throw (settled[0] as PromiseRejectedResult).reason;
    }
    return found;
  }

  /**
   * 백필용. 검색으로 모은 것이 모자랄 때 가장 큰 id부터 아래로 번호를 채운다.
   * 제목을 못 얻은 공지는 본문 첫머리로 무슨 공지인지 판단한다.
   */
  private padWithIds(
    newestFirst: ZiggleNoticeSummary[],
    limit: number,
  ): ZiggleNoticeSummary[] {
    const byId = new Map(newestFirst.map((notice) => [notice.id, notice]));
    const ceiling = newestFirst[0].id;

    for (let id = ceiling; id > 0 && byId.size < limit; id -= 1) {
      if (!byId.has(id)) {
        byId.set(id, { id, title: '', summary: null });
      }
    }
    return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, limit);
  }
}
