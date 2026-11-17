import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import {
  DB_CONNECTION,
  suggestedQuestions,
  widgetKeyCollaborators,
  widgetKeys,
  type Database,
  type SuggestedQuestion,
  type SuggestedQuestionSource,
  type SuggestedQuestionStatus,
} from '../db';
import { normalizeQuestion } from '../unanswered-questions/question-normalizer';

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
  /** null이면 전체 위젯 키(SUPER_ADMIN) */
  widgetKeyIds: string[] | null;
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
   * 관리자가 다룰 수 있는 위젯 키: 본인이 만들었거나 협업자로 수락한 키. 폐기된 키는 뺀다.
   *
   * UnansweredQuestionsRepository.listAccessibleWidgetKeyIds와 같은 규칙이다.
   * 미답변 질문 모듈에 의존을 만들지 않으려고 같은 질의를 여기에 둔다.
   */
  async listAccessibleWidgetKeyIds(adminIdpUuid: string): Promise<string[]> {
    const [owned, shared] = await Promise.all([
      this.db
        .select({ id: widgetKeys.id })
        .from(widgetKeys)
        .where(
          and(
            eq(widgetKeys.createdByIdpUuid, adminIdpUuid),
            ne(widgetKeys.status, 'REVOKED'),
          ),
        ),
      this.db
        .select({ id: widgetKeys.id })
        .from(widgetKeyCollaborators)
        .innerJoin(
          widgetKeys,
          eq(widgetKeyCollaborators.widgetKeyId, widgetKeys.id),
        )
        .where(
          and(
            eq(widgetKeyCollaborators.inviteeIdpUuid, adminIdpUuid),
            eq(widgetKeyCollaborators.status, 'ACCEPTED'),
            ne(widgetKeys.status, 'REVOKED'),
          ),
        ),
    ]);
    return [...new Set([...owned, ...shared].map((row) => row.id))];
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
    // 접근 가능한 키가 하나도 없으면 질의 자체를 건너뛴다.
    if (options.widgetKeyIds?.length === 0) {
      return { rows: [], filteredTotal: 0 };
    }

    const filters: SQL[] = [];
    if (options.widgetKeyIds) {
      filters.push(
        inArray(suggestedQuestions.widgetKeyId, options.widgetKeyIds),
      );
    }
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
}
