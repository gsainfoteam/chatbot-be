import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LLM_CLIENT, type LlmClient } from '../llm/llm-client.interface';
import type { LlmMessage, LlmToolCall, LlmUsage } from '../types/llm.types';
import type { ListResourcesResult } from '../../retrieval/retrieval.types';
import { normalizeForMatch } from '../../retrieval/query-signals';
import { buildAgentResearchPrompt, formatSeoulDate } from '../prompts';
import { readAgentConfig, type AgentConfig } from './agent.config';
import {
  RESEARCH_STEP_KIND,
  type AgentDocument,
  type AgentRunResult,
  type AgentStep,
  type AgentStopReason,
  type AgentTool,
  type AgentToolContext,
  type UsedResource,
} from './agent.types';
import {
  SEARCH_DOCUMENTS_TOOL_NAME,
  SearchDocumentsTool,
  describeDocumentsForAgent,
} from './tools/search-documents.tool';

/** 한 라운드에서 실행할 도구 호출 상한. 넘는 호출은 실행하지 않고 그 사실만 돌려준다. */
const MAX_TOOL_CALLS_PER_ROUND = 4;

/** 조사 라운드 응답 길이. reasoning 토큰도 여기에 포함되는 모델이 있어 너무 줄이지 않는다. */
const AGENT_ROUND_MAX_TOKENS = 2_000;

export type AgentRunInput = {
  question: string;
  history: LlmMessage[];
  catalog: ListResourcesResult;
  usage: LlmUsage;
  /** 빠른 경로에서 이미 한 첫 검색. 같은 검색을 다시 하지 않도록 첫 tool 결과로 넣는다. */
  seed?: { documents: AgentDocument[]; usedResources: UsedResource[] };
  onStep?: (step: AgentStep) => void;
};

/**
 * ReAct 자료 조사 루프.
 * 모델이 도구를 고르고 → 결과를 보고 → 다음 검색을 정한다. 답변은 쓰지 않고,
 * 모은 문서를 돌려주면 호출부가 기존 최종 응답 경로로 답한다.
 */
@Injectable()
export class AgentLoopService {
  private readonly logger = new Logger(AgentLoopService.name);
  private readonly config: AgentConfig;
  private readonly tools: Map<string, AgentTool>;

  constructor(
    @Inject(LLM_CLIENT) private readonly llmClient: LlmClient,
    configService: ConfigService,
    searchDocumentsTool: SearchDocumentsTool,
  ) {
    this.config = readAgentConfig(configService);
    this.tools = new Map(
      [searchDocumentsTool].map((tool) => [
        tool.definition.function.name,
        tool,
      ]),
    );
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const startedAt = Date.now();
    const collected = new DocumentCollector();
    const steps = new Map<string, AgentStep>();
    const executedCalls = new Set<string>();
    const emit = (step: AgentStep) => {
      steps.set(step.id, step);
      input.onStep?.(step);
    };
    const researchStep: AgentStep = {
      id: RESEARCH_STEP_KIND,
      kind: RESEARCH_STEP_KIND,
      label: '자료를 더 찾아보고 있어요',
      status: 'running',
    };
    emit(researchStep);

    const messages: LlmMessage[] = [
      {
        role: 'system',
        content: buildAgentResearchPrompt({
          today: formatSeoulDate(new Date()),
          resources: input.catalog.resources ?? [],
        }),
      },
      ...input.history,
      { role: 'user', content: input.question },
    ];

    if (input.seed) {
      // 첫 검색을 모델이 직접 한 것처럼 보여 줘야 같은 검색어를 반복하지 않는다.
      const seedCallId = 'seed_search_0';
      messages.push(
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: seedCallId,
              type: 'function',
              function: {
                name: SEARCH_DOCUMENTS_TOOL_NAME,
                arguments: JSON.stringify({ query: input.question }),
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: seedCallId,
          name: SEARCH_DOCUMENTS_TOOL_NAME,
          content: describeDocumentsForAgent(input.seed.documents, new Set()),
        },
      );
      collected.add(input.seed.documents, input.seed.usedResources);
      executedCalls.add(
        callKey(SEARCH_DOCUMENTS_TOOL_NAME, { query: input.question }),
      );
    }

    const toolDefinitions = [...this.tools.values()].map(
      (tool) => tool.definition,
    );
    const model = this.llmClient.getModel(this.config.modelTier);
    let rounds = 0;
    let stopReason: AgentStopReason = 'max-rounds';

    while (rounds < this.config.maxRounds) {
      const remainingMs = this.config.timeBudgetMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        stopReason = 'time-budget';
        break;
      }

      rounds += 1;
      let message: LlmMessage | undefined;
      try {
        const response = await this.llmClient.callLLM(messages, model, {
          tools: toolDefinitions,
          tool_choice: 'auto',
          parallel_tool_calls: true,
          temperature: 0,
          max_tokens: AGENT_ROUND_MAX_TOKENS,
          timeoutMs: remainingMs,
        });
        addUsage(input.usage, response.usage);
        message = response.choices?.[0]?.message;
      } catch (error) {
        this.logger.warn(
          `Agent round ${rounds} failed; answering with collected documents: ${describeError(error)}`,
        );
        stopReason = 'llm-error';
        break;
      }

      const toolCalls = message?.tool_calls ?? [];
      if (!message || toolCalls.length === 0) {
        stopReason = 'ready';
        break;
      }

      // 프로바이더가 붙인 추가 필드(예: Gemini thought signature)를 지우지 않도록 메시지를 그대로 넘긴다.
      messages.push({
        ...message,
        role: 'assistant',
        content: message.content ?? null,
      });

      const results = await Promise.all(
        toolCalls.map((call, index) =>
          index < MAX_TOOL_CALLS_PER_ROUND
            ? this.executeCall(call, {
                round: rounds,
                context: {
                  catalog: input.catalog,
                  usage: input.usage,
                  seenPaths: collected.paths(),
                },
                executedCalls,
                emit,
              })
            : Promise.resolve(
                `한 번에 최대 ${MAX_TOOL_CALLS_PER_ROUND}개까지만 실행합니다. 필요하면 다음 차례에 다시 호출하세요.`,
              ),
        ),
      );

      const collectedBefore = collected.size();
      toolCalls.forEach((call, index) => {
        const result = results[index];
        const content = typeof result === 'string' ? result : result.content;
        if (typeof result !== 'string') {
          collected.add(result.documents ?? [], result.usedResources ?? []);
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content,
        });
      });

      // 이미 자료가 있는데 이번 라운드에 새 문서가 없으면 더 돌아도 같은 결과일 가능성이 높다.
      // 자료가 하나도 없을 때는 검색어를 바꿔 보는 것이 이 루프의 목적이므로 계속한다.
      if (collectedBefore > 0 && collected.size() === collectedBefore) {
        stopReason = 'no-progress';
        break;
      }
    }

    const documentCount = collected.size();
    emit({
      ...researchStep,
      status: 'done',
      label:
        documentCount > 0
          ? `자료 ${documentCount}개를 모았어요`
          : '관련 자료를 찾지 못했어요',
      resultCount: documentCount,
    });

    const result: AgentRunResult = {
      documents: collected.documents(),
      usedResources: collected.usedResources(),
      steps: [...steps.values()],
      rounds,
      stopReason,
    };
    this.logger.log(
      `[PERF] agent loop: ${Date.now() - startedAt}ms, rounds=${rounds}, stop=${stopReason}, ` +
        `toolCalls=${result.steps.length - 1}, documents=${result.documents.length}`,
    );
    return result;
  }

  private async executeCall(
    call: LlmToolCall,
    params: {
      round: number;
      context: AgentToolContext;
      executedCalls: Set<string>;
      emit: (step: AgentStep) => void;
    },
  ): Promise<
    | string
    | {
        content: string;
        documents?: AgentDocument[];
        usedResources?: UsedResource[];
      }
  > {
    const name = call.function.name;
    const tool = this.tools.get(name);
    if (!tool) {
      return `알 수 없는 도구입니다: ${name}`;
    }

    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(call.function.arguments || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('arguments must be an object');
      }
      args = parsed as Record<string, unknown>;
    } catch {
      return '도구 인자를 JSON 객체로 읽을 수 없습니다.';
    }

    const key = callKey(name, args);
    if (params.executedCalls.has(key)) {
      return '이미 같은 인자로 실행한 도구입니다. 다른 검색어를 쓰거나 조사를 마치세요.';
    }
    params.executedCalls.add(key);

    const thought =
      typeof args.reason === 'string' && args.reason.trim()
        ? args.reason.trim().slice(0, 80)
        : undefined;
    const step: AgentStep = {
      id: `r${params.round}_${call.id}`,
      kind: name,
      label: tool.describeStep(args, { status: 'running' }),
      status: 'running',
      ...(thought ? { thought } : {}),
    };
    params.emit(step);

    try {
      const result = await tool.execute(args, params.context);
      params.emit({
        ...step,
        status: 'done',
        label: tool.describeStep(args, {
          status: 'done',
          resultCount: result.resultCount,
        }),
        resultCount: result.resultCount,
      });
      return result;
    } catch (error) {
      this.logger.warn(`Agent tool ${name} failed: ${describeError(error)}`);
      params.emit({
        ...step,
        status: 'failed',
        label: tool.describeStep(args, { status: 'failed' }),
      });
      return '도구 실행 중 오류가 발생했습니다. 다른 방법을 시도하거나 조사를 마치세요.';
    }
  }
}

/** 수집 순서를 유지하며 경로 기준으로 중복을 뺀다. */
class DocumentCollector {
  private readonly byPath = new Map<string, AgentDocument>();
  private readonly resources = new Map<string, UsedResource>();

  add(documents: AgentDocument[], usedResources: UsedResource[]): void {
    for (const doc of documents) {
      if (!this.byPath.has(doc.path)) this.byPath.set(doc.path, doc);
    }
    for (const resource of usedResources) {
      if (!this.resources.has(resource.path)) {
        this.resources.set(resource.path, resource);
      }
    }
  }

  paths(): ReadonlySet<string> {
    return new Set(this.byPath.keys());
  }

  size(): number {
    return this.byPath.size;
  }

  documents(): AgentDocument[] {
    return [...this.byPath.values()];
  }

  usedResources(): UsedResource[] {
    return [...this.resources.values()];
  }
}

/** 진행 문구(reason)는 달라도 같은 검색이면 같은 호출로 본다. */
function callKey(name: string, args: Record<string, unknown>): string {
  const normalized = Object.keys(args)
    .filter((key) => key !== 'reason')
    .sort()
    .map((key) => {
      const value = args[key];
      return `${key}=${typeof value === 'string' ? normalizeForMatch(value) : JSON.stringify(value)}`;
    });
  return `${name}(${normalized.join('&')})`;
}

function addUsage(target: LlmUsage, usage: LlmUsage | undefined): void {
  if (!usage) return;
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  target.prompt_tokens += prompt;
  target.completion_tokens += completion;
  target.total_tokens += usage.total_tokens ?? prompt + completion;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
