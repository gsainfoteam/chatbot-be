/**
 * 문서 경로(목록) 선별을 위한 프롬프트
 * - 구 형식: 경로만 있는 플랫 리스트 → 번호로 선택
 * - 신 형식: description + chunks → 번호가 매겨진 세부 chunk를 선택
 */

import type { ListResourceItem } from '../../retrieval/retrieval.types';

export interface ResourcePathSelectionPromptParams {
  pathList: string;
  question: string;
  maxSelect: number;
}

/**
 * 리소스 경로 선별 시스템 프롬프트 (구 형식: 경로만)
 */
export const RESOURCE_PATH_SELECTION_SYSTEM_PROMPT = `
당신은 사용자 질문과 문서 경로(제목)의 관련성을 판단하는 전문가입니다.

선택 기준:
- 문서 경로·제목이 사용자 질문의 **의미·맥락**과 조금이라도 연관될 수 있으면 선택하세요. 질문에 답하는 데 도움이 될 가능성이 있는 문서는 넉넉히 포함하는 편이 좋습니다.
- 예: "장학금 신청" 질문에는 "학생지원", "장학복지", "지원금" 등 관련 경로를 선택하세요. 비슷한 주제·동의어·상위 개념도 포함해 보세요.
- **명확히 질문과 무관한 문서만** 제외하세요. 의심스러우면 선택하세요.
`;

/**
 * 리소스 경로 선별 사용자 프롬프트 생성 (구 형식)
 */
export function getResourcePathSelectionUserPrompt(
  params: ResourcePathSelectionPromptParams,
): string {
  const { pathList, question, maxSelect } = params;

  return `
다음은 사용 가능한 문서 목록입니다 (번호. 경로/제목):

${pathList}

사용자 질문: "${question}"

위 목록에서 사용자 질문과 **의미·맥락상 관련 있을 수 있는** 문서 번호를 선택해주세요.

선택 지침:
- 질문에 답할 때 도움이 될 수 있는 문서를 **가능하면 5개 이상, 최대 ${maxSelect}개** 선택하세요. 넉넉히 선택하는 편이 좋습니다.
- 조금이라도 연관될 수 있다고 보이면 포함하세요. **정말로 단 하나도 관련이 없을 때만** "없음"이라고 하세요.
- 설명 없이 번호만 입력하세요.
`;
}

/** chunk 선별용 프롬프트 파라미터 (신 형식: description + chunks) */
export interface ChunkSelectionPromptParams {
  question: string;
  resourceListText: string;
  maxSelect: number;
}

export type ChunkSelectionCandidate = {
  number: number;
  path: string;
  description: string;
  resourcePath: string;
  resourceDescription: string;
  isRoot: boolean;
  rootPath?: string;
};

/**
 * chunk 선별 시스템 프롬프트 (신 형식: description 보고 관련 chunk 선택)
 */
export const CHUNK_SELECTION_SYSTEM_PROMPT = `
당신은 사용자 질문과 리소스 설명(description)의 관련성을 판단하는 전문가입니다.

각 리소스와 하위 chunk의 description을 보고, 질문에 답할 수 있을 **가능성이 있는 세부 chunk**를 선택하세요.
- 조금이라도 연관될 수 있다고 보이면 포함하세요. 의심스러우면 선택하는 편이 좋습니다.
- 루트 개요는 서버가 별도로 추가하므로, 세부 chunk를 우선 선택하세요.
- 선택한 chunk의 번호만 JSON 배열로 반환합니다. 경로나 설명, 다른 텍스트는 포함하지 마세요.
`;

/**
 * chunk 선별 사용자 프롬프트 생성 (신 형식)
 */
export function getChunkSelectionUserPrompt(
  params: ChunkSelectionPromptParams,
): string {
  const { question, resourceListText, maxSelect } = params;

  return `
사용자 질문: "${question}"

아래 리소스 목록에서 질문에 답할 수 있을 **가능성이 있는** chunk를 선택하세요.
각 리소스와 chunk의 description을 참고하여, 관련 세부 내용을 놓치지 않도록 **가능하면 3개 이상, 최대 ${maxSelect}개** 선택하세요.

리소스 목록:
${resourceListText}

선택한 chunk 번호만 JSON 배열로 반환하세요. 예: [1, 3, 5]
정말로 단 하나도 관련이 없을 때만 빈 배열 []을 반환하세요.
`;
}

/**
 * 루트 개요가 있는 문서는 세부 chunk만 선택 후보로 노출합니다.
 * 세부 chunk가 없는 문서는 검색 가능성을 유지하기 위해 루트 자체를 후보로 둡니다.
 */
export function buildChunkSelectionCandidates(
  resources: ListResourceItem[],
): ChunkSelectionCandidate[] {
  const candidates: ChunkSelectionCandidate[] = [];

  for (const resource of resources) {
    const resourceRootPath = resource.path.replace(/\.pdf$/i, '');
    const root = resource.chunks.find(
      (chunk) => chunk.path === resourceRootPath,
    );
    const details = resource.chunks.filter(
      (chunk) => chunk.path !== resourceRootPath,
    );
    const selectable = details.length > 0 ? details : root ? [root] : [];

    for (const chunk of selectable) {
      candidates.push({
        number: candidates.length + 1,
        path: chunk.path,
        description: chunk.description,
        resourcePath: resource.path,
        resourceDescription: resource.description,
        isRoot: chunk.path === resourceRootPath,
        rootPath: root?.path,
      });
    }
  }

  return candidates;
}

/** 신 형식 후보를 LLM이 복사할 필요 없는 번호 목록으로 포맷합니다. */
export function formatChunkCandidatesForSelection(
  candidates: ChunkSelectionCandidate[],
): string {
  return candidates
    .map(
      (candidate) =>
        `${candidate.number}. [${candidate.isRoot ? '루트 문서' : '세부 chunk'}] ` +
        `문서="${candidate.resourcePath}", 문서 설명="${candidate.resourceDescription}", ` +
        `chunk 설명="${candidate.description}"`,
    )
    .join('\n');
}
