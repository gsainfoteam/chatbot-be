import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import {
  DB_CONNECTION,
  documents,
  messages,
  sessions,
  unansweredQuestions,
  widgetKeyCollaborators,
  widgetKeys,
  type Database,
  type DocumentSourceType,
  type DocumentStatus,
  type UnansweredQuestion,
  type UnansweredQuestionStatus,
} from '../db';
import {
  detectQuestionLanguage,
  normalizeQuestion,
} from './question-normalizer';

export const UNANSWERED_QUESTION_SORTS = ['recent', 'count', 'first'] as const;
export type UnansweredQuestionSort = (typeof UNANSWERED_QUESTION_SORTS)[number];

export interface UnansweredQuestionListQuery {
  /** null이면 전체 위젯 키(SUPER_ADMIN) */
  widgetKeyIds: string[] | null;
  widgetKeyId?: string;
  page: number;
  size: number;
  query?: string;
  status: UnansweredQuestionStatus | 'all';
  sort: UnansweredQuestionSort;
  order: 'asc' | 'desc';
}

export interface UnansweredQuestionRecord {
  question: UnansweredQuestion;
  widgetKeyName: string;
  document: {
    id: string;
    title: string;
    status: DocumentStatus;
    sourceType: DocumentSourceType;
    isActive: boolean;
  } | null;
}

export interface LastAnswerRecord {
  messageId: string;
  content: string;
  createdAt: Date;
}

@Injectable()
export class UnansweredQuestionsRepository {
  constructor(@Inject(DB_CONNECTION) private readonly db: Database) {}

  /**
   * 세션의 위젯 키 기준으로 미답변 질문을 누적한다.
   * countOccurrence=false(답변 재생성)이면 기존 행의 질문 횟수는 늘리지 않는다.
   */
  async record(input: {
    sessionId: string;
    question: string;
    answerMessageId: string | null;
    countOccurrence: boolean;
  }): Promise<UnansweredQuestion | null> {
    const question = input.question.normalize('NFC').trim();
    const normalizedQuestion = normalizeQuestion(question);
    if (!normalizedQuestion) return null;

    const [session] = await this.db
      .select({ widgetKeyId: sessions.widgetKeyId })
      .from(sessions)
      .where(eq(sessions.id, input.sessionId))
      .limit(1);
    if (!session) return null;

    const increment = input.countOccurrence ? 1 : 0;
    const [row] = await this.db
      .insert(unansweredQuestions)
      .values({
        widgetKeyId: session.widgetKeyId,
        question,
        normalizedQuestion,
        language: detectQuestionLanguage(question),
        lastSessionId: input.sessionId,
        lastAnswerMessageId: input.answerMessageId,
      })
      .onConflictDoUpdate({
        target: [
          unansweredQuestions.widgetKeyId,
          unansweredQuestions.normalizedQuestion,
        ],
        set: {
          question: sql`excluded.question`,
          language: sql`excluded.language`,
          askCount: sql`${unansweredQuestions.askCount} + ${increment}`,
          lastSessionId: sql`excluded.last_session_id`,
          lastAnswerMessageId: sql`coalesce(excluded.last_answer_message_id, ${unansweredQuestions.lastAnswerMessageId})`,
          lastAskedAt: input.countOccurrence
            ? sql`now()`
            : sql`${unansweredQuestions.lastAskedAt}`,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return row ?? null;
  }

  /** 직접 만든 키와 ACCEPTED 협업자로 초대받은 키(REVOKED 제외). */
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

  async list(
    options: UnansweredQuestionListQuery,
  ): Promise<{ rows: UnansweredQuestionRecord[]; filteredTotal: number }> {
    if (options.widgetKeyIds?.length === 0) {
      return { rows: [], filteredTotal: 0 };
    }

    const page = Math.max(1, options.page);
    const size = Math.min(Math.max(1, options.size), 100);
    const where = this.listWhere(options);

    const [countRow, rows] = await Promise.all([
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(unansweredQuestions)
        .where(where)
        .then((result) => result[0]),
      this.selectRecords()
        .where(where)
        .orderBy(...this.listOrderBy(options.sort, options.order))
        .limit(size)
        .offset((page - 1) * size),
    ]);

    return {
      filteredTotal: countRow?.count ?? 0,
      rows: rows.map((row) => this.toRecord(row)),
    };
  }

  async findById(id: string): Promise<UnansweredQuestionRecord | null> {
    const [row] = await this.selectRecords()
      .where(eq(unansweredQuestions.id, id))
      .limit(1);
    return row ? this.toRecord(row) : null;
  }

  async findLastAnswer(messageId: string): Promise<LastAnswerRecord | null> {
    const [row] = await this.db
      .select({
        messageId: messages.id,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.role, 'assistant')))
      .limit(1);
    return row ?? null;
  }

  /**
   * RESOLVED는 처리자·처리 시각만 기록하고 연결 문서는 유지한다.
   * OPEN/DISMISSED로 되돌리면 해결 정보를 비운다.
   */
  async updateStatus(
    id: string,
    status: UnansweredQuestionStatus,
    actorIdpUuid: string,
  ): Promise<boolean> {
    const now = new Date();
    const resolution =
      status === 'RESOLVED'
        ? { resolvedAt: now, resolvedByIdpUuid: actorIdpUuid }
        : {
            resolvedAt: null,
            resolvedByIdpUuid: null,
            resolvedDocumentId: null,
          };
    const updated = await this.db
      .update(unansweredQuestions)
      .set({ status, ...resolution, updatedAt: now })
      .where(eq(unansweredQuestions.id, id))
      .returning({ id: unansweredQuestions.id });
    return updated.length > 0;
  }

  async linkDocument(
    id: string,
    documentId: string,
    actorIdpUuid: string,
  ): Promise<boolean> {
    const now = new Date();
    const updated = await this.db
      .update(unansweredQuestions)
      .set({
        status: 'RESOLVED',
        resolvedDocumentId: documentId,
        resolvedAt: now,
        resolvedByIdpUuid: actorIdpUuid,
        updatedAt: now,
      })
      .where(eq(unansweredQuestions.id, id))
      .returning({ id: unansweredQuestions.id });
    return updated.length > 0;
  }

  private selectRecords() {
    return this.db
      .select({
        question: unansweredQuestions,
        widgetKeyName: widgetKeys.name,
        documentId: documents.id,
        documentTitle: documents.title,
        documentStatus: documents.status,
        documentSourceType: documents.sourceType,
        documentIsActive: documents.isActive,
      })
      .from(unansweredQuestions)
      .innerJoin(widgetKeys, eq(unansweredQuestions.widgetKeyId, widgetKeys.id))
      .leftJoin(
        documents,
        eq(unansweredQuestions.resolvedDocumentId, documents.id),
      )
      .$dynamic();
  }

  private toRecord(row: {
    question: UnansweredQuestion;
    widgetKeyName: string;
    documentId: string | null;
    documentTitle: string | null;
    documentStatus: DocumentStatus | null;
    documentSourceType: DocumentSourceType | null;
    documentIsActive: boolean | null;
  }): UnansweredQuestionRecord {
    return {
      question: row.question,
      widgetKeyName: row.widgetKeyName,
      document:
        row.documentId != null
          ? {
              id: row.documentId,
              title: row.documentTitle ?? '',
              status: row.documentStatus ?? 'failed',
              sourceType: row.documentSourceType ?? 'pdf',
              isActive: row.documentIsActive ?? false,
            }
          : null,
    };
  }

  private listWhere(options: UnansweredQuestionListQuery): SQL | undefined {
    const conditions: SQL[] = [];
    if (options.widgetKeyIds) {
      conditions.push(
        inArray(unansweredQuestions.widgetKeyId, options.widgetKeyIds),
      );
    }
    if (options.widgetKeyId) {
      conditions.push(eq(unansweredQuestions.widgetKeyId, options.widgetKeyId));
    }
    if (options.status !== 'all') {
      conditions.push(eq(unansweredQuestions.status, options.status));
    }
    const query = options.query?.trim();
    if (query) {
      const escaped = query.normalize('NFC').replace(/[%_\\]/g, '\\$&');
      conditions.push(
        sql`${unansweredQuestions.question} ILIKE ${`%${escaped}%`} ESCAPE '\\'`,
      );
    }
    return conditions.length > 0 ? and(...conditions) : undefined;
  }

  private listOrderBy(
    sort: UnansweredQuestionSort,
    order: 'asc' | 'desc',
  ): SQL[] {
    const direction = order === 'asc' ? asc : desc;
    if (sort === 'count') {
      return [
        direction(unansweredQuestions.askCount),
        desc(unansweredQuestions.lastAskedAt),
        asc(unansweredQuestions.id),
      ];
    }
    if (sort === 'first') {
      return [
        direction(unansweredQuestions.firstAskedAt),
        asc(unansweredQuestions.id),
      ];
    }
    return [
      direction(unansweredQuestions.lastAskedAt),
      asc(unansweredQuestions.id),
    ];
  }
}
