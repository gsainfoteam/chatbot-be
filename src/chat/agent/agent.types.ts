import type { ListResourcesResult } from '../../retrieval/retrieval.types';
import type { LlmTool, LlmUsage } from '../types/llm.types';

export type AgentDocument = { path: string; content: string };

export type UsedResource = { path: string; formats: string[] };

/** 한 턴 동안 모든 도구가 공유하는 맥락 */
export type AgentToolContext = {
  catalog: ListResourcesResult;
  /** 검색 단계에서 LLM을 쓰면 토큰을 여기에 더한다. */
  usage: LlmUsage;
  /** 이미 에이전트에게 보여준 문서 경로. 같은 본문을 다시 넘기지 않으려고 쓴다. */
  seenPaths: ReadonlySet<string>;
};

export type AgentToolResult = {
  /** 에이전트 모델에게 tool 메시지로 돌려줄 내용 */
  content: string;
  /** 진행 단계에 표시할 결과 수 */
  resultCount: number;
  /** 최종 답변 근거로 모을 문서 */
  documents?: AgentDocument[];
  usedResources?: UsedResource[];
};

export type AgentStepStatus = 'running' | 'done' | 'failed';

export type AgentStepOutcome =
  | { status: 'running' }
  | { status: 'done'; resultCount: number }
  | { status: 'failed' };

export interface AgentTool {
  readonly definition: LlmTool;
  execute(
    args: Record<string, unknown>,
    context: AgentToolContext,
  ): Promise<AgentToolResult>;
  /** 진행 단계 문구. 모델 문체에 기대지 않도록 서버가 인자로 만든다. */
  describeStep(
    args: Record<string, unknown>,
    outcome: AgentStepOutcome,
  ): string;
}

/** 조사 전체를 감싸는 단계의 kind. 첫 도구 호출 전 대기 시간에도 진행 상태를 보여준다. */
export const RESEARCH_STEP_KIND = 'research';

/** FE에 진행 과정으로 보여줄 수 있는 단위. 모델의 원본 추론문은 담지 않는다. */
export type AgentStep = {
  id: string;
  /** `research` 또는 도구 이름 */
  kind: string;
  /** 서버가 만든 진행 문구 */
  label: string;
  status: AgentStepStatus;
  /** 모델이 tool 인자 `reason`으로 남긴 짧은 설명. 보조 문구로만 쓴다. */
  thought?: string;
  resultCount?: number;
};

export type AgentStopReason =
  | 'ready'
  | 'no-progress'
  | 'max-rounds'
  | 'time-budget'
  | 'llm-error';

export type AgentRunResult = {
  /** 경로 기준으로 중복을 뺀, 수집 순서대로의 문서 */
  documents: AgentDocument[];
  usedResources: UsedResource[];
  steps: AgentStep[];
  rounds: number;
  stopReason: AgentStopReason;
};
