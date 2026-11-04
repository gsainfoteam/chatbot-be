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
    | 'required'
    | { type: 'function'; function: { name: string } };
  parallel_tool_calls?: boolean;
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

/** 구글 검색 그라운딩 결과. 문장(supports)마다 근거 출처(chunks) 인덱스가 붙는다. */
export type GoogleSearchGrounding = {
  queries: string[];
  /** uri는 구글 리다이렉트 링크다. title은 보통 도메인 이름이다. */
  chunks: Array<{ uri: string; title: string }>;
  supports: Array<{ text: string; chunkIndices: number[] }>;
  /** 구글 검색 추천 칩 HTML. 그라운딩 이용 조건상 결과와 함께 보여줘야 할 수 있다. */
  searchEntryPointHtml?: string;
};

export type GroundedSearchResponse = {
  content: string;
  /** 모델이 검색하지 않았거나 프로바이더가 메타데이터를 주지 않으면 null */
  grounding: GoogleSearchGrounding | null;
  usage?: LlmUsage;
};

/** 용도별 모델 티어 (light: 선별, normal: 단순 응답, heavy: 최종 답변) */
export type LlmModelType = 'light' | 'normal' | 'heavy';

export type LlmToolResult = {
  tool_call_id: string;
  name: string;
  content: string;
};
