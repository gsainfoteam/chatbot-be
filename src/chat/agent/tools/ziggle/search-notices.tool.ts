import { Injectable } from '@nestjs/common';
import { normalizeForMatch } from '../../../../retrieval/query-signals';
import type {
  AgentDocument,
  AgentStepOutcome,
  AgentTool,
  AgentToolContext,
  AgentToolResult,
  ExternalSource,
} from '../../agent.types';
import { maskPersonalInfo } from './notice-text';
import {
  NOTICE_MARKER,
  noticeDocumentPath,
  noticeRegistry,
} from './notice-registry';
import {
  ZiggleNoticeClient,
  type ZiggleNoticeSummary,
} from './ziggle-notice.client';

export const SEARCH_NOTICES_TOOL_NAME = 'search_notices';

const MAX_KEYWORDS = 4;
const MAX_KEYWORD_CHARS = 20;
/** 키워드 하나당 Ziggle에서 받아 오는 공지 수 */
const PER_KEYWORD_LIMIT = 8;
/** 에이전트에게 보여주는 합친 결과 수 */
const MAX_RESULTS = 6;
/** 최종 답변 자료로 넘기는 요약 수 */
const MAX_SUMMARY_DOCUMENTS = 5;
const MAX_SUMMARY_CHARS_FOR_AGENT = 400;

/**
 * Ziggle 공지 검색. Ziggle은 질의 문자열 전체의 부분일치로 찾기 때문에
 * 짧은 키워드 여러 개를 따로 검색해 합친다. 여러 키워드에 걸린 공지를 앞에 둔다.
 */
@Injectable()
export class SearchNoticesTool implements AgentTool {
  readonly maxCalls = 4;
  readonly maxCallsPerRound = 1;
  readonly definition = {
    type: 'function' as const,
    function: {
      name: SEARCH_NOTICES_TOOL_NAME,
      description:
        'Ziggle에 올라온 GIST 공지(학사공지 포함)를 최신순으로 찾는다. 모집·신청 기간, 장학, 학사 일정, 행사처럼 시기에 따라 바뀌는 정보에 쓴다. 결과는 공지 id, 제목, 요약이다.',
      parameters: {
        type: 'object',
        properties: {
          keywords: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: MAX_KEYWORDS,
            description:
              '공지 본문에 그대로 들어 있을 1~2단어 명사 2~4개. 조사·어미·"이번 학기" 같은 표현은 뺀다. 좋은 예: ["장학생", "선발"] 나쁜 예: ["이번 학기 장학금 신청 기간"]',
          },
          reason: {
            type: 'string',
            description:
              '이 검색이 왜 필요한지 사용자에게 말하듯 쓴 해요체 한 문장(30자 이내).',
          },
        },
        required: ['keywords', 'reason'],
      },
    },
  };

  constructor(private readonly ziggle: ZiggleNoticeClient) {}

  async execute(
    args: Record<string, unknown>,
    context: AgentToolContext,
  ): Promise<AgentToolResult> {
    const keywords = readKeywords(args);
    if (keywords.length === 0) {
      return { content: 'keywords가 비어 있습니다.', resultCount: 0 };
    }

    const settled = await Promise.allSettled(
      keywords.map((keyword) =>
        this.ziggle.searchNotices(keyword, PER_KEYWORD_LIMIT),
      ),
    );
    const lists = settled.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    if (lists.length === 0) {
      throw (settled[0] as PromiseRejectedResult).reason;
    }

    const merged = mergeByHits(lists)
      .slice(0, MAX_RESULTS)
      .map((n) => ({
        ...n,
        title: maskPersonalInfo(n.title),
        summary: n.summary ? maskPersonalInfo(n.summary).slice(0, 4000) : null,
      }));
    if (merged.length === 0) {
      return {
        content:
          '검색 결과가 없습니다. 더 짧거나 다른 단어(공식 명칭, 상위 개념)로 다시 찾아보세요.',
        resultCount: 0,
      };
    }

    const registry = noticeRegistry(context);
    for (const notice of merged) {
      registry.set(notice.id, {
        title: notice.title,
        summary: notice.summary,
      });
    }

    const documents: AgentDocument[] = [];
    const sources: ExternalSource[] = [];
    for (const notice of merged) {
      if (!notice.summary || documents.length >= MAX_SUMMARY_DOCUMENTS) {
        continue;
      }
      documents.push({
        path: noticeDocumentPath(notice.id, 'summary'),
        content: `${NOTICE_MARKER} ${notice.title}\n요약: ${maskPersonalInfo(notice.summary)}`,
      });
      sources.push({
        kind: 'notice',
        id: String(notice.id),
        title: notice.title,
        url: this.ziggle.noticeUrl(notice.id),
        opened: false,
      });
    }

    const lines = merged.map((notice) => {
      const summary = notice.summary
        ? maskPersonalInfo(notice.summary).slice(0, MAX_SUMMARY_CHARS_FOR_AGENT)
        : '(요약 없음. 필요하면 get_notice로 본문을 확인)';
      return `- [id=${notice.id}] [path=${noticeDocumentPath(notice.id, 'summary')}] ${notice.title}\n  요약: ${summary}`;
    });
    return {
      content: `최신순 공지 ${merged.length}개:\n${lines.join('\n')}`,
      resultCount: merged.length,
      documents,
      sources,
      candidates: merged
        .filter((n) => !n.summary)
        .map((n) => `ziggle-notice/${n.id}`),
    };
  }

  describeStep(
    args: Record<string, unknown>,
    outcome: AgentStepOutcome,
  ): string {
    switch (outcome.status) {
      case 'running': {
        const keywords = readKeywords(args)
          .map((keyword) => `'${keyword}'`)
          .join(', ');
        return keywords
          ? `Ziggle에서 ${keywords} 공지를 찾고 있어요`
          : 'Ziggle 공지를 찾고 있어요';
      }
      case 'done':
        return outcome.resultCount > 0
          ? `Ziggle 공지 ${outcome.resultCount}개를 불러왔어요`
          : 'Ziggle에서 관련 공지를 찾지 못했어요';
      case 'failed':
        return 'Ziggle 공지를 불러오지 못했어요';
    }
  }
}

function readKeywords(args: Record<string, unknown>): string[] {
  const raw = Array.isArray(args.keywords) ? args.keywords : [];
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const keyword = value.trim().slice(0, MAX_KEYWORD_CHARS);
    const key = normalizeForMatch(keyword);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keywords.push(keyword);
    if (keywords.length >= MAX_KEYWORDS) break;
  }
  return keywords;
}

/** 여러 키워드에 걸린 공지를 앞으로, 같으면 최신(큰 id) 공지를 앞으로 */
export function mergeByHits(
  lists: ZiggleNoticeSummary[][],
): ZiggleNoticeSummary[] {
  const byId = new Map<number, { notice: ZiggleNoticeSummary; hits: number }>();
  for (const list of lists) {
    for (const notice of list) {
      const entry = byId.get(notice.id);
      if (entry) entry.hits += 1;
      else byId.set(notice.id, { notice, hits: 1 });
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.hits - a.hits || b.notice.id - a.notice.id)
    .map((entry) => entry.notice);
}
