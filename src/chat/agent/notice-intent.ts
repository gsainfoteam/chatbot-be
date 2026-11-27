import { extractQuerySignals } from '../../retrieval/query-signals';

/**
 * 공지가 필요할 가능성이 큰 질문인지 규칙으로 본다.
 * 놓치면 공지를 못 찾고, 잘못 잡으면 답이 몇 초 늦을 뿐이라 넓게 잡는다.
 */
const NOTICE_INTENT =
  /신청|모집|접수|마감|기한|기간|일정|선발|공지|공고|장학|설명회|특강|세미나|행사|대회|공모|채용|인턴|휴강|보강|시간표|연기|언제|이번\s*(?:학기|주|달|년)|다음\s*(?:학기|주|달)|올해|내년|오늘|내일/;

/** 시기를 특정하는 exact 신호. "2026 하계", "2학기", "9월 18일" 같은 표현 */
const TIME_SIGNAL_KINDS = new Set(['year', 'semester', 'date']);

export function hasNoticeIntent(question: string): boolean {
  if (NOTICE_INTENT.test(question)) return true;
  return extractQuerySignals(question).exactSignals.some((signal) =>
    TIME_SIGNAL_KINDS.has(signal.kind),
  );
}
