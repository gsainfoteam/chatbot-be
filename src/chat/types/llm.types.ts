/**
 * OpenAI-compatible chat completions 메시지 형식
 */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: LlmToolCall[];
}

/**
 * Function calling tool call 형식
 */
export interface LlmToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

/**
 * OpenAI-compatible chat completions 요청 형식
 */
export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  tool_choice?:
    | 'auto'
    | 'none'
    | { type: 'function'; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
}

export interface LlmTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: string;
      properties?: Record<string, any>;
      required?: string[];
    };
  };
}

export interface LlmUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * OpenAI-compatible chat completions 응답 형식
 */
export interface LlmResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: LlmMessage;
    finish_reason: 'stop' | 'length' | 'tool_calls' | null;
  }>;
  usage?: LlmUsage;
}

/** 용도별 모델 티어 (light: 선별, normal: 단순 응답, heavy: 최종 답변) */
export type LlmModelType = 'light' | 'normal' | 'heavy';

export type LlmToolResult = {
  tool_call_id: string;
  name: string;
  content: string;
};
