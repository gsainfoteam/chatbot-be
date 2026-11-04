import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LLM_CLIENT, type LlmClient } from '../../../llm/llm-client.interface';
import type { LlmUsage } from '../../../types/llm.types';
import { formatSeoulDate } from '../../../prompts';
import {
  extractFindings,
  resolveGroundingUrl,
  type DomainPolicy,
  type WebFinding,
} from './grounded-findings';

export const DEFAULT_WEB_SEARCH_MODEL = 'gemini-2.5-flash';
export const DEFAULT_WEB_SEARCH_TIMEOUT_MS = 15_000;
const DEFAULT_OFFICIAL_DOMAINS = ['gist.ac.kr'];
/**
 * 출처 리다이렉트 하나를 푸는 시간 상한. 여러 개를 병렬로 푼다.
 * 구글 리다이렉트 응답이 2~3초 걸리는 때가 있어 여유를 둔다.
 */
const RESOLVE_TIMEOUT_MS = 6_000;

/** 검색 모델에게 주는 지시. 모델의 일반 지식이 섞이지 않게 하고, 근거 매핑으로 한 번 더 거른다. */
function searchSystemPrompt(today: string): string {
  return `너는 GIST(광주과학기술원) 챗봇의 웹 검색 담당이다. 오늘 날짜는 ${today}이다.
반드시 Google 검색을 실행하고, 검색 결과에 실제로 적힌 사실만 한국어로 짧게 정리하라.
- 추측, 일반 지식, "예상", "보통" 같은 표현은 쓰지 마라.
- GIST와 관계없는 다른 학교·기관의 정보는 쓰지 마라.
- 검색 결과에서 찾지 못한 내용은 쓰지 말고, 아무것도 못 찾았으면 "검색 결과 없음"만 써라.
- 5문장 이내로 쓴다.`;
}

export type WebSearchResult = {
  findings: WebFinding[];
  /** 모델이 실제로 실행한 검색어 */
  queries: string[];
  /** 구글 검색 추천 칩 HTML. 표시 의무 검토가 끝날 때까지 로그로만 확인한다. */
  searchEntryPointHtml?: string;
};

/**
 * Gemini 구글 검색 그라운딩으로 웹을 검색한다.
 * 모델이 쓴 요약 대신 근거 매핑(groundingSupports)이 있는 문장만 돌려준다.
 */
@Injectable()
export class WebSearchClient {
  private readonly logger = new Logger(WebSearchClient.name);
  private readonly enabled: boolean;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly widgetKeyIds: ReadonlySet<string> | null;
  private readonly policy: DomainPolicy;

  constructor(
    @Inject(LLM_CLIENT) private readonly llmClient: LlmClient,
    configService: ConfigService,
  ) {
    const enabled = configService.get<boolean | string>('WEB_SEARCH_ENABLED');
    this.enabled = enabled === true || String(enabled).toLowerCase() === 'true';
    this.model =
      configService.get<string>('WEB_SEARCH_MODEL')?.trim() ||
      DEFAULT_WEB_SEARCH_MODEL;
    const timeoutMs = Number(configService.get('WEB_SEARCH_TIMEOUT_MS'));
    this.timeoutMs =
      Number.isInteger(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : DEFAULT_WEB_SEARCH_TIMEOUT_MS;

    const widgetIds = splitList(
      configService.get<string>('WEB_SEARCH_WIDGET_KEY_IDS'),
    );
    this.widgetKeyIds = widgetIds.includes('*') ? null : new Set(widgetIds);

    const official = splitList(
      configService.get<string>('WEB_SEARCH_OFFICIAL_DOMAINS'),
    );
    this.policy = {
      allowedDomains: splitList(
        configService.get<string>('WEB_SEARCH_ALLOWED_DOMAINS'),
      ),
      officialDomains:
        official.length > 0 ? official : DEFAULT_OFFICIAL_DOMAINS,
    };
  }

  isEnabledFor(widgetKeyId: string | undefined): boolean {
    if (!this.enabled) return false;
    if (this.widgetKeyIds === null) return true;
    return widgetKeyId != null && this.widgetKeyIds.has(widgetKeyId);
  }

  async search(
    query: string,
    usage: LlmUsage,
    signal?: AbortSignal,
  ): Promise<WebSearchResult> {
    signal?.throwIfAborted();
    const startedAt = Date.now();
    const response = await this.llmClient.searchWithGoogle(
      [
        {
          role: 'system',
          content: searchSystemPrompt(formatSeoulDate(new Date())),
        },
        { role: 'user', content: query },
      ],
      this.model,
      { temperature: 0, max_tokens: 1500, timeoutMs: this.timeoutMs, signal },
    );
    if (response.usage) {
      usage.prompt_tokens += response.usage.prompt_tokens ?? 0;
      usage.completion_tokens += response.usage.completion_tokens ?? 0;
      usage.total_tokens += response.usage.total_tokens ?? 0;
    }

    const grounding = response.grounding;
    if (!grounding) {
      this.logger.log(
        `[PERF] web search: ${Date.now() - startedAt}ms, no grounding (model did not search)`,
      );
      return { findings: [], queries: [] };
    }

    // 근거로 쓰인 출처만 실제 주소로 푼다.
    const usedIndices = new Set(
      grounding.supports.flatMap((support) => support.chunkIndices),
    );
    const resolved = await Promise.all(
      grounding.chunks.map((chunk, index) =>
        usedIndices.has(index)
          ? resolveGroundingUrl(chunk.uri, RESOLVE_TIMEOUT_MS, fetch, signal)
          : Promise.resolve(null),
      ),
    );
    signal?.throwIfAborted();
    const findings = extractFindings(grounding, resolved, this.policy);
    this.logger.log(
      `[PERF] web search: ${Date.now() - startedAt}ms, queries=${grounding.queries.length}, ` +
        `chunks=${grounding.chunks.length}, supports=${grounding.supports.length}, kept=${findings.length}, ` +
        `entryPoint=${Boolean(grounding.searchEntryPointHtml)}`,
    );
    return {
      findings,
      queries: grounding.queries,
      searchEntryPointHtml: grounding.searchEntryPointHtml,
    };
  }
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
