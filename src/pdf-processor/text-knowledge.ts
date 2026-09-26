import { toResourceName } from './pdf-chunk-parser';

/** 관리자가 입력한 텍스트 지식 본문의 최대 길이 */
export const TEXT_KNOWLEDGE_MAX_CHARS = 100_000;

/**
 * 텍스트 지식 문서의 resource_name.
 * 경로 구분자는 chunk 경로(`{resourceName}/...`)와 충돌하므로 치환한다.
 */
export function toTextResourceName(title: string): string {
  return toResourceName(title.trim().replace(/[\\/]+/g, '-')).trim();
}

/** 제목을 문서 맥락 헤딩(`#`)으로 붙여 Pass 2 입력 마크다운을 만든다. */
export function buildTextKnowledgeMarkdown(
  title: string,
  sourceText: string,
): string {
  return `# ${title.trim()}\n\n${sourceText.trim()}`;
}
