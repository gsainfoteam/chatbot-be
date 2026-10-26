import type { Readable } from 'stream';
import type {
  LlmMessage,
  LlmModelType,
  LlmRequest,
  LlmResponse,
  LlmTool,
  LlmToolResult,
} from '../types/llm.types';

export const LLM_CLIENT = Symbol('LLM_CLIENT');

export type LlmCallOptions = {
  temperature?: number;
  max_tokens?: number;
  /** axios request timeout in milliseconds (default 15000) */
  timeoutMs?: number;
  /** function calling에 노출할 도구. 비어 있으면 요청에 싣지 않는다. */
  tools?: LlmTool[];
  tool_choice?: LlmRequest['tool_choice'];
  /** 독립적인 도구 호출을 한 응답에 여러 개 받을지 여부 */
  parallel_tool_calls?: boolean;
};

/**
 * OpenAI-compatible LLM 클라이언트 인터페이스
 * Letsur / OpenRouter 등 프로바이더 구현체가 이 계약을 따릅니다.
 */
export interface LlmClient {
  getModel(type: LlmModelType): string;

  callLLM(
    messages: LlmMessage[],
    model?: string,
    options?: LlmCallOptions,
  ): Promise<LlmResponse>;

  generateFinalResponseStream(
    messages: LlmMessage[],
    toolResults: LlmToolResult[],
    model?: string,
    options?: { temperature?: number },
  ): Promise<Readable>;
}
