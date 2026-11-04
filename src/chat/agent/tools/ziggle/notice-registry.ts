import type { AgentToolContext } from '../../agent.types';

export type KnownNotice = { title: string; summary: string | null };

const REGISTRY_KEY = 'ziggle.notices';

/** 한 번의 조사에서 검색으로 본 공지. get_notice가 제목을 쓰고, 검색에 없던 id를 막는 데 쓴다. */
export function noticeRegistry(
  context: AgentToolContext,
): Map<number, KnownNotice> {
  let registry = context.state.get(REGISTRY_KEY) as
    | Map<number, KnownNotice>
    | undefined;
  if (!registry) {
    registry = new Map();
    context.state.set(REGISTRY_KEY, registry);
  }
  return registry;
}

/** 진행 문구에 넣는 공지 제목 길이 상한 */
const MAX_TITLE_CHARS_IN_LABEL = 30;

export function shortTitle(title: string): string {
  return title.length > MAX_TITLE_CHARS_IN_LABEL
    ? `${title.slice(0, MAX_TITLE_CHARS_IN_LABEL)}…`
    : title;
}

/** 최종 답변 자료에서 공지임을 알아보는 표지. 답변 프롬프트가 이 표지를 기준으로 규칙을 건다. */
export const NOTICE_MARKER = '[Ziggle 공지]';

export function noticeDocumentPath(id: number, part: 'summary' | 'body') {
  return part === 'body'
    ? `ziggle-notice/${id}`
    : `ziggle-notice/${id}/summary`;
}
