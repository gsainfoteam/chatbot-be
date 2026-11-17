import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DB_CONNECTION, suggestedQuestions, type Database } from '../db';

/** 위젯에 내보낼 수 있는 최소 필드. prompt는 일부러 들어 있지 않다. */
export interface ApprovedQuestionRecord {
  id: string;
  question: string;
}

@Injectable()
export class SuggestedQuestionsRepository {
  constructor(@Inject(DB_CONNECTION) private readonly db: Database) {}

  /**
   * 위젯 첫 화면에 노출할 질문 목록.
   *
   * - 승인된(APPROVED) 질문만 내보낸다. 검수 전(PENDING)이나 거절된 질문은 보이지 않는다.
   * - 위젯 키로 범위를 좁혀 다른 위젯의 질문이 섞이지 않게 한다.
   * - prompt를 select 하지 않는다. 조회 단계에서 빼야 위에서 실수로 흘려보낼 수 없다.
   * - 최신 공지에서 나온 질문이 위로 오도록 created_at 내림차순.
   *   한 번의 주기 작업이 같은 시각에 여러 건을 넣으므로 id를 보조 정렬 키로 둬
   *   호출할 때마다 순서가 흔들리지 않게 한다.
   */
  async listApproved(
    widgetKeyId: string,
    limit: number,
  ): Promise<ApprovedQuestionRecord[]> {
    return this.db
      .select({
        id: suggestedQuestions.id,
        question: suggestedQuestions.question,
      })
      .from(suggestedQuestions)
      .where(
        and(
          eq(suggestedQuestions.widgetKeyId, widgetKeyId),
          eq(suggestedQuestions.status, 'APPROVED'),
        ),
      )
      .orderBy(desc(suggestedQuestions.createdAt), desc(suggestedQuestions.id))
      .limit(limit);
  }
}
