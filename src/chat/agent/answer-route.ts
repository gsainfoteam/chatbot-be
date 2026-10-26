/**
 * 빠른 경로(기존 단발 RAG)와 에이전트 재탐색 중 무엇으로 답할지 정한다.
 * LLM을 쓰지 않으므로 빠른 경로에는 지연이 더해지지 않는다.
 */

export type AnswerRoute = 'direct' | 'agent';

export type AnswerRouteReason =
  | 'agent-disabled'
  | 'confident-match'
  | 'unscored-match'
  | 'no-documents'
  | 'weak-match';

export function decideAnswerRoute(params: {
  agentEnabled: boolean;
  /** 첫 검색으로 찾은 문서 수 */
  documentCount: number;
  /** 벡터 선별의 신뢰도. LLM 선별처럼 판단 근거가 없으면 undefined */
  confident?: boolean;
}): { route: AnswerRoute; reason: AnswerRouteReason } {
  if (!params.agentEnabled) {
    return { route: 'direct', reason: 'agent-disabled' };
  }
  if (params.documentCount === 0) {
    return { route: 'agent', reason: 'no-documents' };
  }
  if (params.confident === false) {
    return { route: 'agent', reason: 'weak-match' };
  }
  // 근거 점수가 없는 LLM 선별 결과는 지금처럼 바로 답한다.
  return {
    route: 'direct',
    reason: params.confident ? 'confident-match' : 'unscored-match',
  };
}
