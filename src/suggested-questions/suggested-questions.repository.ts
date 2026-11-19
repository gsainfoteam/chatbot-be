import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, ne, sql, type SQL } from 'drizzle-orm';
import {
  DB_CONNECTION,
  noticeQuestionIngestions,
  suggestedQuestions,
  widgetKeys,
  type Database,
  type SuggestedQuestion,
  type SuggestedQuestionSource,
  type SuggestedQuestionStatus,
} from '../db';
import { normalizeQuestion } from '../unanswered-questions/question-normalizer';
import { max } from 'drizzle-orm';

/** 위젯에 내보낼 수 있는 최소 필드. prompt는 일부러 들어 있지 않다. */
export interface ApprovedQuestionRecord {
  id: string;
  question: string;
}

/** 관리자 화면용. 어느 위젯 키인지 이름까지 같이 보여준다. */
export interface AdminQuestionRecord {
  question: SuggestedQuestion;
  widgetKeyName: string;
}

export interface AdminQuestionListQuery {
  widgetKeyId?: string;
  page: number;
  size: number;
  status: SuggestedQuestionStatus | 'all';
  source: SuggestedQuestionSource | 'all';
}

export interface CreateSuggestedQuestionInput {
  widgetKeyId: string;
  question: string;
  prompt: string;
  source: SuggestedQuestionSource;
  status: SuggestedQuestionStatus;
  createdByIdpUuid: string | null;
  reviewedByIdpUuid: string | null;
  reviewedAt: Date | null;
  noticeId?: number | null;
  noticeTitle?: string | null;
}

export interface UpdateSuggestedQuestionInput {
  question?: string;
  prompt?: string;
  status?: SuggestedQuestionStatus;
  reviewedByIdpUuid?: string;
  reviewedAt?: Date;
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

  /**
   * 질문 등록. 같은 위젯 키에 같은 질문이 이미 있으면 null을 돌려준다.
   * 유니크 위반을 예외로 받지 않고 onConflictDoNothing으로 처리해,
   * 드라이버별 오류 코드에 기대지 않는다.
   */
  async create(
    input: CreateSuggestedQuestionInput,
  ): Promise<SuggestedQuestion | null> {
    const [row] = await this.db
      .insert(suggestedQuestions)
      .values({
        widgetKeyId: input.widgetKeyId,
        question: input.question,
        normalizedQuestion: normalizeQuestion(input.question),
        prompt: input.prompt,
        source: input.source,
        status: input.status,
        createdByIdpUuid: input.createdByIdpUuid,
        reviewedByIdpUuid: input.reviewedByIdpUuid,
        reviewedAt: input.reviewedAt,
        noticeId: input.noticeId ?? null,
        noticeTitle: input.noticeTitle ?? null,
      })
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  }

  async list(
    options: AdminQuestionListQuery,
  ): Promise<{ rows: AdminQuestionRecord[]; filteredTotal: number }> {
    const filters: SQL[] = [];
    if (options.widgetKeyId) {
      filters.push(eq(suggestedQuestions.widgetKeyId, options.widgetKeyId));
    }
    if (options.status !== 'all') {
      filters.push(eq(suggestedQuestions.status, options.status));
    }
    if (options.source !== 'all') {
      filters.push(eq(suggestedQuestions.source, options.source));
    }
    const where = filters.length > 0 ? and(...filters) : undefined;

    const [rows, [total]] = await Promise.all([
      this.db
        .select({
          question: suggestedQuestions,
          widgetKeyName: widgetKeys.name,
        })
        .from(suggestedQuestions)
        .innerJoin(
          widgetKeys,
          eq(suggestedQuestions.widgetKeyId, widgetKeys.id),
        )
        .where(where)
        .orderBy(
          desc(suggestedQuestions.createdAt),
          desc(suggestedQuestions.id),
        )
        .limit(options.size)
        .offset((options.page - 1) * options.size),
      this.db.select({ value: count() }).from(suggestedQuestions).where(where),
    ]);

    return { rows, filteredTotal: total?.value ?? 0 };
  }

  async findById(id: string): Promise<AdminQuestionRecord | null> {
    const [row] = await this.db
      .select({
        question: suggestedQuestions,
        widgetKeyName: widgetKeys.name,
      })
      .from(suggestedQuestions)
      .innerJoin(widgetKeys, eq(suggestedQuestions.widgetKeyId, widgetKeys.id))
      .where(eq(suggestedQuestions.id, id))
      .limit(1);
    return row ?? null;
  }

  /** 위젯 키 이름. 없는 키면 null */
  async findWidgetKeyName(widgetKeyId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ name: widgetKeys.name })
      .from(widgetKeys)
      .where(eq(widgetKeys.id, widgetKeyId))
      .limit(1);
    return row?.name ?? null;
  }

  /** 같은 위젯 키에 같은 질문이 이미 있는지. excludeId는 자기 자신을 제외할 때 쓴다. */
  async existsSameQuestion(
    widgetKeyId: string,
    question: string,
    excludeId?: string,
  ): Promise<boolean> {
    const filters: SQL[] = [
      eq(suggestedQuestions.widgetKeyId, widgetKeyId),
      eq(suggestedQuestions.normalizedQuestion, normalizeQuestion(question)),
    ];
    if (excludeId) filters.push(ne(suggestedQuestions.id, excludeId));
    const [row] = await this.db
      .select({ id: suggestedQuestions.id })
      .from(suggestedQuestions)
      .where(and(...filters))
      .limit(1);
    return row != null;
  }

  /**
   * 내용·상태 수정. 질문을 고치면 중복 판정 키도 같이 다시 만든다.
   * 중복 검사는 호출 쪽에서 existsSameQuestion으로 먼저 한다. 여기까지 와서
   * 유니크 제약에 걸리면 예외가 그대로 올라간다.
   */
  async update(
    id: string,
    patch: UpdateSuggestedQuestionInput,
  ): Promise<SuggestedQuestion | null> {
    const [row] = await this.db
      .update(suggestedQuestions)
      .set({
        ...patch,
        ...(patch.question === undefined
          ? {}
          : { normalizedQuestion: normalizeQuestion(patch.question) }),
        updatedAt: sql`now()`,
      })
      .where(eq(suggestedQuestions.id, id))
      .returning();
    return row ?? null;
  }

  // ------------------------------------------------- 공지 처리 장부

  /**
   * 이 위젯 키로 지금까지 처리한 가장 큰 공지 id. 한 번도 돈 적이 없으면 null.
   *
   * Ziggle 검색은 최신순이 아니라 오래된 공지도 섞여 오므로, 이 값을 커서로 써서
   * "전에 본 것보다 새 공지"만 고른다. null과 0은 뜻이 다르다. null은 첫 실행이라
   * 씨딩만 하고 질문은 만들지 않는다는 신호다.
   */
  async maxIngestedNoticeId(widgetKeyId: string): Promise<number | null> {
    const [row] = await this.db
      .select({ value: max(noticeQuestionIngestions.noticeId) })
      .from(noticeQuestionIngestions)
      .where(eq(noticeQuestionIngestions.widgetKeyId, widgetKeyId));
    return row?.value ?? null;
  }

  /**
   * 공지 선점. 행을 먼저 만들고, 만드는 데 성공한 쪽만 질문을 생성한다.
   *
   * 유니크 기본키 덕분에 "확인하고 나서 쓰기" 사이의 틈이 없다. 인스턴스 두 대가
   * 같은 순간에 들어와도 한쪽은 반드시 0행을 받는다. 락을 잡지 않으므로 뒤이은
   * LLM 호출이 길어져도 DB 커넥션을 붙들지 않는다.
   *
   * @returns 내가 선점했으면 true, 이미 처리된 공지면 false
   */
  async claimNotice(widgetKeyId: string, noticeId: number): Promise<boolean> {
    const rows = await this.db
      .insert(noticeQuestionIngestions)
      .values({ widgetKeyId, noticeId })
      .onConflictDoNothing()
      .returning({ noticeId: noticeQuestionIngestions.noticeId });
    return rows.length > 0;
  }

  /**
   * 선점 취소. LLM 호출이 네트워크 오류 등으로 실패했을 때만 쓴다.
   * 장부에서 빼 두면 다음 주기에 다시 집어 간다.
   *
   * 응답은 왔는데 만들 질문이 없었던 경우에는 부르지 않는다. 그건 "질문거리 없는 공지"라는
   * 정상 결과이고, 장부에 남겨 둬야 같은 공지를 매 주기 다시 LLM에 넣지 않는다.
   */
  async releaseNotice(widgetKeyId: string, noticeId: number): Promise<void> {
    await this.db
      .delete(noticeQuestionIngestions)
      .where(
        and(
          eq(noticeQuestionIngestions.widgetKeyId, widgetKeyId),
          eq(noticeQuestionIngestions.noticeId, noticeId),
        ),
      );
  }

  /**
   * 첫 실행용. 지금 보이는 공지를 "처리함"으로만 기록하고 질문은 만들지 않는다.
   * 이게 없으면 첫 실행에서 과거 공지 수백 건에 LLM을 돌리게 된다.
   *
   * @returns 새로 기록한 공지 수
   */
  async seedNotices(widgetKeyId: string, noticeIds: number[]): Promise<number> {
    if (noticeIds.length === 0) return 0;
    const rows = await this.db
      .insert(noticeQuestionIngestions)
      .values(noticeIds.map((noticeId) => ({ widgetKeyId, noticeId })))
      .onConflictDoNothing()
      .returning({ noticeId: noticeQuestionIngestions.noticeId });
    return rows.length;
  }
}
