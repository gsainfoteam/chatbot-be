import { Injectable } from '@nestjs/common';
import { normalizeForMatch } from '../../../../retrieval/query-signals';
import type {
  AgentStepOutcome,
  AgentTool,
  AgentToolContext,
  AgentToolResult,
  ExternalSource,
} from '../../agent.types';
import { maskPersonalInfo } from '../ziggle/notice-text';
import { withEulReul } from '../korean-particle';
import type { WebFinding } from './grounded-findings';
import { WebSearchClient } from './web-search.client';

export const SEARCH_WEB_TOOL_NAME = 'search_web';

/** 최종 답변 자료에서 웹 검색 결과임을 알아보는 표지 */
export const WEB_MARKER = '[웹 검색]';

const MAX_QUERY_CHARS = 100;
const MAX_QUERY_CHARS_IN_LABEL = 30;

/** 내부 문서·공지로 부족할 때만 쓰는 웹 검색 */
@Injectable()
export class SearchWebTool implements AgentTool {
  readonly definition = {
    type: 'function' as const,
    function: {
      name: SEARCH_WEB_TOOL_NAME,
      description:
        '구글로 웹을 검색한다. 내부 문서와 Ziggle 공지로 답을 찾지 못했을 때만 쓴다. 근거 출처가 있는 문장만 돌려준다.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              '검색 문장. 학교 맥락이 드러나게 "GIST" 또는 "광주과학기술원"을 넣는다. 예: "GIST 기숙사 외박 신청 방법"',
          },
          reason: {
            type: 'string',
            description:
              '왜 웹까지 찾아보는지 사용자에게 말하듯 쓴 해요체 한 문장(30자 이내).',
          },
        },
        required: ['query', 'reason'],
      },
    },
  };

  constructor(private readonly webSearch: WebSearchClient) {}

  async execute(
    args: Record<string, unknown>,
    context: AgentToolContext,
  ): Promise<AgentToolResult> {
    const query = readQuery(args);
    if (!query) return { content: 'query가 비어 있습니다.', resultCount: 0 };

    const { findings } = await this.webSearch.search(query, context.usage);
    if (findings.length === 0) {
      return {
        content:
          '웹 검색 결과에서 근거가 있는 관련 내용을 찾지 못했습니다. 웹 검색을 반복하지 말고 조사를 마치세요.',
        resultCount: 0,
      };
    }

    const agentLines = findings.map((finding) => formatFinding(finding, false));
    const documentLines = findings.map((finding) =>
      formatFinding(finding, true),
    );
    return {
      content: `웹 검색 결과(근거 출처가 있는 문장만, 공식 출처가 아니면 신뢰도가 낮음):\n${agentLines.join('\n')}`,
      resultCount: findings.length,
      documents: [
        {
          path: `web-search/${normalizeForMatch(query)}`,
          content: `${WEB_MARKER} '${query}' 검색 결과\n${documentLines.join('\n')}`,
        },
      ],
      sources: toSources(findings),
    };
  }

  describeStep(
    args: Record<string, unknown>,
    outcome: AgentStepOutcome,
  ): string {
    const raw = readQuery(args);
    const query =
      raw.length > MAX_QUERY_CHARS_IN_LABEL
        ? `${raw.slice(0, MAX_QUERY_CHARS_IN_LABEL)}…`
        : raw;
    switch (outcome.status) {
      case 'running':
        return `웹에서 '${query}'${withEulReul(query)} 찾고 있어요`;
      case 'done':
        return outcome.resultCount > 0
          ? `웹에서 관련 내용 ${outcome.resultCount}건을 찾았어요`
          : '웹에서 근거 있는 내용을 찾지 못했어요';
      case 'failed':
        return '웹 검색에 실패했어요';
    }
  }
}

function readQuery(args: Record<string, unknown>): string {
  return typeof args.query === 'string'
    ? args.query.trim().slice(0, MAX_QUERY_CHARS)
    : '';
}

/**
 * 사실 한 줄. 최종 답변 자료에는 출처를 마크다운 링크로 넣어 답변이 그대로 인용할 수 있게 하고,
 * 에이전트에게는 긴 URL 없이 도메인만 보여준다.
 */
function formatFinding(finding: WebFinding, withLinks: boolean): string {
  const origin = finding.sources
    .map((source) => {
      const label =
        withLinks && source.resolved
          ? `[${source.domain}](${source.url})`
          : source.domain;
      return `${label}${source.official ? ', 공식' : ''}`;
    })
    .join(' / ');
  return `- ${maskPersonalInfo(finding.text)} (출처: ${origin})`;
}

/** 공식 출처를 앞에 두고, 같은 주소는 하나로 합친다. */
function toSources(findings: WebFinding[]): ExternalSource[] {
  const byUrl = new Map<string, ExternalSource>();
  for (const finding of findings) {
    for (const ref of finding.sources) {
      if (byUrl.has(ref.url)) continue;
      byUrl.set(ref.url, {
        kind: 'web',
        id: ref.url,
        title: ref.domain,
        url: ref.url,
        opened: false,
        official: ref.official,
      });
    }
  }
  return [...byUrl.values()].sort(
    (a, b) => Number(b.official) - Number(a.official),
  );
}
