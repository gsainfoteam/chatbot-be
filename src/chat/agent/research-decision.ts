import type { LlmTool } from '../types/llm.types';

export type ResearchAssessment = {
  outcome: 'complete' | 'partial' | 'insufficient';
  evidencePaths: string[];
  unresolvedQuestions: string[];
  reason: string;
};

export const FINISH_RESEARCH = 'finish_research';
export const finishResearchTool: LlmTool = {
  type: 'function',
  function: {
    name: FINISH_RESEARCH,
    description:
      '수집한 근거를 평가하고 조사를 종료한다. 검색 결과가 존재한다는 이유만으로 완료하지 않는다. 읽을 후보와 다른 검색 경로가 남아 있으면 먼저 조사한다.',
    parameters: {
      type: 'object',
      properties: {
        outcome: {
          type: 'string',
          enum: ['complete', 'partial', 'insufficient'],
        },
        evidencePaths: {
          type: 'array',
          items: { type: 'string' },
          description:
            '실제로 질문의 답을 뒷받침하는 자료 경로. 도구가 반환한 경로만 사용한다.',
        },
        unresolvedQuestions: {
          type: 'array',
          items: { type: 'string' },
          description: '아직 답하지 못한 하위 질문. complete일 때만 비어 있다.',
        },
        reason: {
          type: 'string',
          description:
            '종료 근거를 짧게 설명한다. 부분 답변/근거 부족이면 추가로 확인할 수 없는 이유를 쓴다.',
        },
      },
      required: ['outcome', 'evidencePaths', 'unresolvedQuestions', 'reason'],
    },
  },
};

export function readResearchAssessment(
  raw: string,
  knownPaths: ReadonlySet<string>,
): ResearchAssessment | null {
  try {
    const value = JSON.parse(raw) as ResearchAssessment;
    if (
      !value ||
      !['complete', 'partial', 'insufficient'].includes(value.outcome)
    )
      return null;
    if (
      !Array.isArray(value.evidencePaths) ||
      !Array.isArray(value.unresolvedQuestions)
    )
      return null;
    if (
      !value.evidencePaths.every(
        (p) => typeof p === 'string' && knownPaths.has(p),
      )
    )
      return null;
    if (
      !value.unresolvedQuestions.every(
        (q) => typeof q === 'string' && q.trim().length > 0 && q.length <= 300,
      )
    )
      return null;
    if (
      value.evidencePaths.length > 50 ||
      value.unresolvedQuestions.length > 10
    )
      return null;
    if (
      typeof value.reason !== 'string' ||
      !value.reason.trim() ||
      value.reason.length > 500
    )
      return null;
    if (value.outcome !== 'insufficient' && value.evidencePaths.length === 0)
      return null;
    if (value.outcome === 'complete' && value.unresolvedQuestions.length !== 0)
      return null;
    if (value.outcome !== 'complete' && value.unresolvedQuestions.length === 0)
      return null;
    return { ...value, evidencePaths: [...new Set(value.evidencePaths)] };
  } catch {
    return null;
  }
}
