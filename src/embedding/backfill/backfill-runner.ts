import {
  buildChunkEmbeddingInput,
  type ChunkEmbeddingSource,
} from '../chunk-embedding-input';

export interface BackfillChunk extends ChunkEmbeddingSource {
  id: string;
}

export interface BackfillStore {
  upperBound(): Promise<string | null>;
  readBatch(
    after: string | null,
    through: string,
    limit: number,
    all: boolean,
  ): Promise<BackfillChunk[]>;
  saveBatch(
    rows: BackfillChunk[],
    vectors: number[][],
    all: boolean,
  ): Promise<number>;
}

export interface BackfillResult {
  selected: number;
  saved: number;
  failed: number;
}

/** Only input-specific errors should fan out into smaller requests. */
function isInputError(error: unknown): boolean {
  const response = (
    error as {
      response?: { status?: number; data?: { error?: { code?: string } } };
    } | null
  )?.response;
  return (
    response?.status === 413 ||
    response?.status === 422 ||
    (response?.status === 400 &&
      [
        'context_length_exceeded',
        'invalid_input',
        'invalid_input_length',
        'string_above_max_length',
      ].includes(response.data?.error?.code ?? ''))
  );
}

export async function runBackfill(
  store: BackfillStore,
  embed: (texts: string[], signal: AbortSignal) => Promise<number[][]>,
  options: {
    batchSize: number;
    all?: boolean;
    signal: AbortSignal;
    onProgress?: (result: BackfillResult) => void;
    onInputFailure?: (id: string) => void;
  },
): Promise<BackfillResult> {
  const result: BackfillResult = { selected: 0, saved: 0, failed: 0 };
  const all = options.all ?? false;
  options.signal.throwIfAborted();
  // Bound each pass, even if uploads continue while it is running.
  const through = await store.upperBound();
  if (!through) return result;

  async function processBatch(rows: BackfillChunk[]): Promise<void> {
    options.signal.throwIfAborted();
    let vectors: number[][];
    try {
      vectors = await embed(rows.map(buildChunkEmbeddingInput), options.signal);
    } catch (error) {
      options.signal.throwIfAborted();
      if (!isInputError(error)) throw error;
      if (rows.length === 1) {
        result.failed += 1;
        options.onInputFailure?.(rows[0].id);
        return;
      }
      const middle = Math.floor(rows.length / 2);
      await processBatch(rows.slice(0, middle));
      await processBatch(rows.slice(middle));
      return;
    }
    options.signal.throwIfAborted();
    result.saved += await store.saveBatch(rows, vectors, all);
  }

  let after: string | null = null;
  while (!options.signal.aborted) {
    const rows = await store.readBatch(after, through, options.batchSize, all);
    if (!rows.length) break;
    result.selected += rows.length;
    await processBatch(rows);
    after = rows[rows.length - 1].id;
    options.onProgress?.({ ...result });
  }
  options.signal.throwIfAborted();
  return result;
}
