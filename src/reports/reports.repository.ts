import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import { alias, type PgColumn } from 'drizzle-orm/pg-core';
import {
  DB_CONNECTION,
  type Database,
  messageFeedbacks,
  messages,
  sessions,
  unansweredQuestions,
  widgetKeys,
} from '../db';

/** KST 달력 기준 기간. start 이상 end 미만이며 둘 다 'YYYY-MM-DD'. */
export interface ReportPeriod {
  start: string;
  end: string;
}

export type ProblemKind = 'bad' | 'unanswered';

/**
 * KST 날짜 0시를 created_at과 같은 형태(DB 세션 시간대의 timestamp)로 바꾼다.
 * created_at은 DB 시계(now())로 저장되므로 DB 시간대와 무관하게 경계가 맞는다.
 */
const kstStart = (date: string) =>
  sql`((${date}::timestamp AT TIME ZONE 'Asia/Seoul') AT TIME ZONE current_setting('TimeZone'))`;

const within = (column: PgColumn, period: ReportPeriod): SQL =>
  and(gte(column, kstStart(period.start)), lt(column, kstStart(period.end)))!;

@Injectable()
export class ReportsRepository {
  constructor(@Inject(DB_CONNECTION) private readonly db: Database) {}

  async widgetKeyExists(widgetKeyId: string): Promise<boolean> {
    const [key] = await this.db
      .select({ id: widgetKeys.id })
      .from(widgetKeys)
      .where(eq(widgetKeys.id, widgetKeyId))
      .limit(1);
    return Boolean(key);
  }

  /** 질문·답변·사용자·토큰·응답 시간과 피드백 수를 한 번에 센다(답변 생성 시각 기준). */
  async summarize(widgetKeyId: string, period: ReportPeriod) {
    const [row] = await this.db
      .select({
        questions: sql<number>`(count(*) filter (where ${messages.role} = 'user'))::int`,
        answers: sql<number>`(count(*) filter (where ${messages.role} = 'assistant'))::int`,
        users: sql<number>`(count(distinct coalesce(${sessions.endUserKey}, ${sessions.id}::text)) filter (where ${messages.role} = 'user'))::int`,
        tokens: sql<number>`coalesce(sum((${messages.metadata}->'usage'->>'total_tokens')::bigint), 0)::float8`,
        avgResponseMs: sql<
          number | null
        >`round(avg((${messages.metadata}->'evaluation'->>'totalMs')::numeric))::int`,
        good: sql<number>`(count(${messageFeedbacks.id}) filter (where ${messageFeedbacks.rating} = 'GOOD'))::int`,
        bad: sql<number>`(count(${messageFeedbacks.id}) filter (where ${messageFeedbacks.rating} = 'BAD'))::int`,
        regenerated: sql<number>`(count(*) filter (where ${messages.metadata}->>'regeneratedFromFeedback' = 'BAD'))::int`,
      })
      .from(messages)
      .innerJoin(sessions, eq(sessions.id, messages.sessionId))
      .leftJoin(messageFeedbacks, eq(messageFeedbacks.messageId, messages.id))
      .where(
        and(
          eq(sessions.widgetKeyId, widgetKeyId),
          within(messages.createdAt, period),
        ),
      );
    return row;
  }

  /** 답변 결과(evaluation.outcome)별 답변 수. 기록이 없으면 outcome이 null이다. */
  countOutcomes(widgetKeyId: string, period: ReportPeriod) {
    const outcome = sql<
      string | null
    >`${messages.metadata}->'evaluation'->>'outcome'`;
    return this.db
      .select({ outcome, count: sql<number>`count(*)::int` })
      .from(messages)
      .innerJoin(sessions, eq(sessions.id, messages.sessionId))
      .where(
        and(
          eq(sessions.widgetKeyId, widgetKeyId),
          eq(messages.role, 'assistant'),
          within(messages.createdAt, period),
        ),
      )
      .groupBy(outcome);
  }

  /**
   * BAD 피드백을 받았거나(bad) 참고 자료 없이 답한(unanswered) 답변의 질문을 최신순으로 돌려준다.
   * 질문은 답변 시각 이전의 마지막 사용자 질문이며, 재생성 답변은 원래 답변 시각을 기준으로 찾는다.
   */
  async listProblemQuestions(
    widgetKeyId: string,
    period: ReportPeriod,
    kind: ProblemKind,
  ): Promise<string[]> {
    const original = alias(messages, 'original_answer');
    const rows = await this.db
      .select({
        question: sql<string | null>`(
          select q.content from messages q
          where q.session_id = ${messages.sessionId} and q.role = 'user'
            and q.created_at <= coalesce(${original.createdAt}, ${messages.createdAt})
          order by q.created_at desc
          limit 1
        )`,
      })
      .from(messages)
      .innerJoin(sessions, eq(sessions.id, messages.sessionId))
      .leftJoin(
        original,
        sql`${original.id} = (${messages.metadata}->>'regeneratedFromMessageId')::uuid`,
      )
      .leftJoin(messageFeedbacks, eq(messageFeedbacks.messageId, messages.id))
      .where(
        and(
          eq(sessions.widgetKeyId, widgetKeyId),
          eq(messages.role, 'assistant'),
          within(messages.createdAt, period),
          kind === 'bad'
            ? eq(messageFeedbacks.rating, 'BAD')
            : sql`${messages.metadata}->'evaluation'->>'outcome' = 'unanswered'`,
        ),
      )
      .orderBy(desc(messages.createdAt));
    return rows.flatMap((row) => (row.question ? [row.question] : []));
  }

  /** 이 기간에 새로 생긴 미답변 질문 수와 해결된 수. */
  async countUnansweredChanges(widgetKeyId: string, period: ReportPeriod) {
    const [row] = await this.db
      .select({
        created: sql<number>`(count(*) filter (where ${within(unansweredQuestions.createdAt, period)}))::int`,
        resolved: sql<number>`(count(*) filter (where ${within(unansweredQuestions.resolvedAt, period)}))::int`,
      })
      .from(unansweredQuestions)
      .where(eq(unansweredQuestions.widgetKeyId, widgetKeyId));
    return row;
  }
}
