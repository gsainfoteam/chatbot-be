import type { Readable } from 'stream';
import type {
  LlmMessage,
  LlmModelType,
  LlmResponse,
  LlmToolResult,
} from '../types/llm.types';

export const LLM_CLIENT = Symbol('LLM_CLIENT');

export type LlmCallOptions = {
  temperature?: number;
  max_tokens?: number;
  /** axios request timeout in milliseconds (default 15000) */
  timeoutMs?: number;
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
