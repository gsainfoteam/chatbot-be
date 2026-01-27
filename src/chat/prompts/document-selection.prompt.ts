/**
 * 문서 선택을 위한 프롬프트
 */

export interface DocumentSelectionPromptParams {
  documentList: string;
  question: string;
}

/**
 * 문서 선택 시스템 프롬프트
 */
export const DOCUMENT_SELECTION_SYSTEM_PROMPT =
  '당신은 문서의 관련성을 판단하는 전문가입니다. 사용자 질문에 실제로 도움이 되는 문서만 선택하세요.';

/**
 * 문서 선택 사용자 프롬프트 생성
 */
export function getDocumentSelectionUserPrompt(
  params: DocumentSelectionPromptParams,
): string {
  const { documentList, question } = params;

  return `다음은 사용자 질문에 대한 관련 문서 목록입니다:

          ${documentList}

          사용자 질문: "${question}"

          위 문서들 중에서 사용자 질문에 **실제로 도움이 되는** 문서만 선택해주세요.
          **최대 3개까지만** 선택해주세요. 가장 관련성이 높은 문서만 선택하세요.
          문서 번호만 쉼표로 구분하여 나열해주세요. 예: "1, 3, 5"
          모든 문서가 도움이 되지 않으면 "없음"이라고 답변해주세요.`;
}
