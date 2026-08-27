import { createHash } from 'node:crypto';
import { MAX_EMBEDDING_INPUT_BYTES } from './embedding.constants';

export type CanonicalEmbeddingChunk = {
  documentTitle: string;
  documentSummary: string | null | undefined;
  path: string;
  description: string;
  content: string;
};

function normalizeEmbeddingField(value: string | null | undefined): string {
  return (value ?? '').normalize('NFC').replace(/\r\n?/g, '\n').trim();
}

export function truncateEmbeddingInput(input: string): string {
  const normalized = normalizeEmbeddingField(input);
  if (!normalized) return '';
  if (Buffer.byteLength(normalized, 'utf8') <= MAX_EMBEDDING_INPUT_BYTES) {
    return normalized;
  }

  let bytes = 0;
  let end = 0;
  for (const character of normalized) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > MAX_EMBEDDING_INPUT_BYTES) break;
    bytes += characterBytes;
    end += character.length;
  }
  return normalized.slice(0, end);
}

/** Deterministic text used for both embedding generation and stale detection. */
export function buildCanonicalEmbeddingText(
  chunk: CanonicalEmbeddingChunk,
): string {
  const sections = [
    `Document title:\n${normalizeEmbeddingField(chunk.documentTitle)}`,
    `Document summary:\n${normalizeEmbeddingField(chunk.documentSummary)}`,
    `Chunk path:\n${normalizeEmbeddingField(chunk.path)}`,
    `Chunk description:\n${normalizeEmbeddingField(chunk.description)}`,
    `Chunk content:\n${normalizeEmbeddingField(chunk.content)}`,
  ];
  return truncateEmbeddingInput(sections.join('\n\n'));
}

export function hashEmbeddingContent(canonicalText: string): string {
  return createHash('sha256').update(canonicalText, 'utf8').digest('hex');
}
