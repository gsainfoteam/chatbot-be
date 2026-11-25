import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
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

/** 위젯에 내보내는 필드. 검수 정보(공지 제목·검수자 등)는 넣지 않는다. */
export interface ActiveQuestionRecord {
  id: string;
  question: string;
  /** 관리자 질문은 null일 수 있다. */
  prompt: string | null;
  source: SuggestedQuestionSource;
}

/** 첫 화면에 띄울 수 있는 기한인지. null은 무기한이다. 문서 기한(retrieval)과 같은 규칙. */
function notExpired(now: Date): SQL {
  return or(
    isNull(suggestedQuestions.expiresAt),
    gt(suggestedQuestions.expiresAt, now),
  ) as SQL;
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
  expiry: 'all' | 'active' | 'expired';
}

export interface CreateSuggestedQuestionInput {
  widgetKeyId: string;
  question: string;
  prompt: string | null;
  source: SuggestedQuestionSource;
  status: SuggestedQuestionStatus;
  createdByIdpUuid: string | null;
  reviewedByIdpUuid: string | null;
  reviewedAt: Date | null;
  noticeId?: number | null;
  noticeTitle?: string | null;
  /** 승인 전 후보는 아직 기한이 없다(null). */
  expiresAt?: Date | null;
}

export interface UpdateSuggestedQuestionInput {
  question?: string;
  /** null은 prompt를 지우는 것이다. */
  prompt?: string | null;
  status?: SuggestedQuestionStatus;
  reviewedByIdpUuid?: string;
  reviewedAt?: Date;
  /** null은 무기한으로 바꾸는 것이다. 빠지면 그대로 둔다. */
  expiresAt?: Date | null;
}

@Injectable()
export class SuggestedQuestionsRepository {
  constructor(@Inject(DB_CONNECTION) private readonly db: Database) {}

  /**
   * 위젯 첫 화면에 띄울 질문을 한 출처에서 무작위로 고른다.
   *
   * - 승인(APPROVED)됐고 기한 전(또는 무기한)인 질문만. 검수 전·거절·기한 지난 질문은 보이지 않는다.
   * - 위젯 키로 범위를 좁혀 다른 위젯의 질문이 섞이지 않게 한다.
   * - 필요한 열만 select 한다. 검수 정보가 위젯 응답으로 흘러가지 않게 조회 단계에서 막는다.
   * - 우선순위 없이 ORDER BY random()이다. 새로고침할 때마다 다른 질문이 뜨게 하려는 것.
   *   위젯 키 하나에 활성 질문은 많아야 수십 건이라 random() 정렬 비용은 문제가 안 된다.
   */
  async pickActive(
    widgetKeyId: string,
    source: SuggestedQuestionSource,
    limit: number,
    now: Date = new Date(),
  ): Promise<ActiveQuestionRecord[]> {
    return this.db
      .select({
        id: suggestedQuestions.id,
        question: suggestedQuestions.question,
        prompt: suggestedQuestions.prompt,
        source: suggestedQuestions.source,
      })
      .from(suggestedQuestions)
      .where(
        and(
          eq(suggestedQuestions.widgetKeyId, widgetKeyId),
          eq(suggestedQuestions.status, 'APPROVED'),
          eq(suggestedQuestions.source, source),
          notExpired(now),
        ),
      )
      .orderBy(sql`random()`)
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
        expiresAt: input.expiresAt ?? null,
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
    const now = new Date();
    if (options.expiry === 'active') {
      filters.push(notExpired(now));
    } else if (options.expiry === 'expired') {
      filters.push(lte(suggestedQuestions.expiresAt, now));
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
   * 이 위젯 키로 이미 처리한 공지 id. 주어진 후보 중에서만 찾는다.
   *
   * 커서(MAX(notice_id))는 쓰지 않는다. Ziggle 검색은 최신순이 아니라 오래된 공지도
   * 섞여 오기 때문에, 커서 방식이면 한 주기 상한에 걸려 남은 공지가 커서에 추월당해
   * 영영 집히지 않았다. 후보를 장부와 직접 맞춰 보면 그 문제가 생기지 않는다.
   */
  async ingestedNoticeIds(
    widgetKeyId: string,
    noticeIds: number[],
  ): Promise<Set<number>> {
    if (noticeIds.length === 0) return new Set();
    const rows = await this.db
      .select({ noticeId: noticeQuestionIngestions.noticeId })
      .from(noticeQuestionIngestions)
      .where(
        and(
          eq(noticeQuestionIngestions.widgetKeyId, widgetKeyId),
          inArray(noticeQuestionIngestions.noticeId, noticeIds),
        ),
      );
    return new Set(rows.map((row) => row.noticeId));
  }

  /**
   * 처리한 공지를 장부에 기록한다. 질문 생성이 **끝난 뒤에만** 부른다.
   *
   * 질문을 못 만든 경우(본문이 이미지뿐이거나 모델이 물어볼 게 없다고 판단한 경우)에도
   * 기록한다. 다시 돌려도 결과가 같은 확정된 결론이라, 매 주기 같은 공지를 또 읽을
   * 이유가 없다. 반대로 네트워크 오류처럼 예외로 끊긴 공지는 기록하지 않아 다음
   * 주기에 다시 집어 간다.
   *
   * 배포가 겹쳐 pod 두 대가 같은 공지를 동시에 처리하면 LLM이 두 번 돌 수 있다.
   * 기본키 충돌을 무시하므로 장부는 깨지지 않고, 중복 질문은 유니크 인덱스가 막는다.
   */
  async recordNotice(widgetKeyId: string, noticeId: number): Promise<void> {
    await this.db
      .insert(noticeQuestionIngestions)
      .values({ widgetKeyId, noticeId })
      .onConflictDoNothing();
  }
}
