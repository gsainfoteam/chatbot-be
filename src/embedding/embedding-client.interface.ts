export const EMBEDDING_CLIENT = Symbol('EMBEDDING_CLIENT');

/** OpenAI-compatible embedding API abstraction, independent of LlmClient. */
export interface EmbeddingClient {
  readonly model: string;
  readonly dimensions: number;
  embedTexts(inputs: string[]): Promise<number[][]>;
}
