/**
 * 청크 임베딩 입력 텍스트 조립.
 * ingest(worker)와 백필 스크립트가 동일한 입력을 사용해야
 * 질의 임베딩과의 유사도 비교가 일관됩니다.
 */

/** text-embedding-3 계열 입력 한도(8,191 토큰)를 한글 기준 넉넉히 밑도는 문자 수 */
const MAX_CONTENT_CHARS = 4000;

export type ChunkEmbeddingSource = {
  documentTitle: string;
  path: string;
  description: string;
  content: string;
};

export function buildChunkEmbeddingInput(source: ChunkEmbeddingSource): string {
  const content =
    source.content.length > MAX_CONTENT_CHARS
      ? source.content.slice(0, MAX_CONTENT_CHARS)
      : source.content;

  return [
    `문서: ${source.documentTitle}`,
    `경로: ${source.path}`,
    `설명: ${source.description}`,
    '',
    content,
  ]
    .join('\n')
    .trim();
}
