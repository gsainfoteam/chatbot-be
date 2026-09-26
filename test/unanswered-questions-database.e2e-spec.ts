import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  documents,
  messages,
  organizations,
  sessions,
  unansweredQuestions,
  widgetKeyCollaborators,
  widgetKeys,
  type Database,
} from '../src/db';
import * as schema from '../src/db/schema';
import { UnansweredQuestionsRepository } from '../src/unanswered-questions/unanswered-questions.repository';

/**
 * 실행 예:
 *   UNANSWERED_QUESTIONS_TEST_DB=true DB_NAME=..._test \
 *   bun run test:e2e -- unanswered-questions-database
 * 마이그레이션이 적용된 테스트 DB가 필요하다.
 */
const describeDatabase =
  process.env.UNANSWERED_QUESTIONS_TEST_DB === 'true'
    ? describe
    : describe.skip;

describeDatabase('Unanswered questions database (e2e)', () => {
  const testPrefix = `uq-e2e-${Date.now()}`;
  const ownerUuid = `${testPrefix}-owner`;
  const collaboratorUuid = `${testPrefix}-collaborator`;
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let repo: UnansweredQuestionsRepository;
  let ownerKeyId: string;
  let revokedKeyId: string;
  let otherKeyId: string;
  let sessionId: string;
  let otherSessionId: string;
  let organizationId: string;
  const documentIds: string[] = [];

  beforeAll(async () => {
    const database = process.env.DB_NAME ?? '';
    if (!database.endsWith('_test')) {
      throw new Error(
        'Unanswered questions database E2E requires DB_NAME ending in _test',
      );
    }
    client = postgres({
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 5432),
      database,
      username: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
      max: 3,
      // timestamp(without time zone) 컬럼을 앱 시계와 DB 시계로 섞어 쓰면
      // UTC가 아닌 세션에서 어긋나므로, 일부러 비UTC 세션으로 검증한다.
      connection: { TimeZone: 'Asia/Seoul' },
    });
    db = drizzle(client, { schema });
    repo = new UnansweredQuestionsRepository(db as unknown as Database);

    const [ownerKey, revokedKey, otherKey] = await db
      .insert(widgetKeys)
      .values([
        {
          name: `${testPrefix} owner`,
          secretKey: `${testPrefix}-owner`,
          createdByIdpUuid: ownerUuid,
          allowedDomains: ['localhost'],
        },
        {
          name: `${testPrefix} revoked`,
          secretKey: `${testPrefix}-revoked`,
          createdByIdpUuid: ownerUuid,
          status: 'REVOKED',
        },
        {
          name: `${testPrefix} other`,
          secretKey: `${testPrefix}-other`,
          createdByIdpUuid: `${testPrefix}-other-owner`,
        },
      ])
      .returning();
    ownerKeyId = ownerKey.id;
    revokedKeyId = revokedKey.id;
    otherKeyId = otherKey.id;

    await db.insert(widgetKeyCollaborators).values({
      widgetKeyId: ownerKeyId,
      inviteeEmail: `${testPrefix}-collaborator@example.com`,
      inviteeIdpUuid: collaboratorUuid,
      status: 'ACCEPTED',
      invitedByIdpUuid: ownerUuid,
    });

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const [session, otherSession] = await db
      .insert(sessions)
      .values([
        {
          widgetKeyId: ownerKeyId,
          sessionToken: `${testPrefix}-session`,
          pageUrl: 'http://localhost/chat',
          expiresAt,
        },
        {
          widgetKeyId: otherKeyId,
          sessionToken: `${testPrefix}-other-session`,
          pageUrl: 'http://localhost/chat',
          expiresAt,
        },
      ])
      .returning();
    sessionId = session.id;
    otherSessionId = otherSession.id;

    const [organization] = await db
      .insert(organizations)
      .values({ name: `${testPrefix} org`, slug: `${testPrefix}-org` })
      .returning();
    organizationId = organization.id;
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .delete(widgetKeys)
      .where(inArray(widgetKeys.id, [ownerKeyId, revokedKeyId, otherKeyId]));
    if (documentIds.length > 0) {
      await db.delete(documents).where(inArray(documents.id, documentIds));
    }
    await db.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
  });

  async function answer(content: string) {
    const [row] = await db
      .insert(messages)
      .values({ sessionId, role: 'assistant', content })
      .returning();
    return row.id;
  }

  it('accumulates repeated questions per widget key by normalized text', async () => {
    const firstAnswer = await answer('자료가 없습니다.');
    const first = await repo.record({
      sessionId,
      question: '부산에서 계좌 만들 수 있나요?',
      answerMessageId: firstAnswer,
      countOccurrence: true,
    });
    const secondAnswer = await answer('자료가 없습니다 (2).');
    const second = await repo.record({
      sessionId,
      question: '  부산에서   계좌 만들 수 있나요 ',
      answerMessageId: secondAnswer,
      countOccurrence: true,
    });
    const regenerated = await repo.record({
      sessionId,
      question: '부산에서 계좌 만들 수 있나요?',
      answerMessageId: null,
      countOccurrence: false,
    });

    expect(second?.id).toBe(first?.id);
    expect(second?.occurrenceCount).toBe(2);
    expect(second?.question).toBe('부산에서   계좌 만들 수 있나요');
    expect(second?.lastAnswerMessageId).toBe(secondAnswer);
    expect(regenerated?.occurrenceCount).toBe(2);
    // 재생성 기록에 답변 ID가 없으면 직전 답변을 유지한다.
    expect(regenerated?.lastAnswerMessageId).toBe(secondAnswer);

    const other = await repo.record({
      sessionId: otherSessionId,
      question: '부산에서 계좌 만들 수 있나요?',
      answerMessageId: null,
      countOccurrence: true,
    });
    expect(other?.id).not.toBe(first?.id);
    expect(other?.widgetKeyId).toBe(otherKeyId);
  });

  it('ignores blank questions and unknown sessions', async () => {
    await expect(
      repo.record({
        sessionId,
        question: ' ?? ',
        answerMessageId: null,
        countOccurrence: true,
      }),
    ).resolves.toBeNull();
    await expect(
      repo.record({
        sessionId: '00000000-0000-0000-0000-000000000000',
        question: '세션 없음',
        answerMessageId: null,
        countOccurrence: true,
      }),
    ).resolves.toBeNull();
  });

  it('lists owned and collaborated keys except revoked ones', async () => {
    expect(await repo.listAccessibleWidgetKeyIds(ownerUuid)).toEqual([
      ownerKeyId,
    ]);
    expect(await repo.listAccessibleWidgetKeyIds(collaboratorUuid)).toEqual([
      ownerKeyId,
    ]);
    expect(
      await repo.listAccessibleWidgetKeyIds(`${testPrefix}-nobody`),
    ).toEqual([]);
  });

  it('filters, searches and sorts within the given widget keys', async () => {
    await repo.record({
      sessionId,
      question: '도서관 스터디룸 예약 방법',
      answerMessageId: null,
      countOccurrence: true,
    });

    const scoped = await repo.list({
      widgetKeyIds: [ownerKeyId],
      page: 1,
      size: 20,
      status: 'open',
      sort: 'count',
      order: 'desc',
    });
    expect(scoped.filteredTotal).toBe(2);
    expect(scoped.rows[0].question.occurrenceCount).toBe(2);
    expect(
      scoped.rows.every((r) => r.question.widgetKeyId === ownerKeyId),
    ).toBe(true);
    expect(scoped.rows[0].widgetKeyName).toBe(`${testPrefix} owner`);

    const searched = await repo.list({
      widgetKeyIds: [ownerKeyId],
      page: 1,
      size: 20,
      query: '  계좌   만들 ',
      status: 'all',
      sort: 'created',
      order: 'desc',
    });
    expect(searched.filteredTotal).toBe(1);

    const wildcard = await repo.list({
      widgetKeyIds: [ownerKeyId],
      page: 1,
      size: 20,
      query: '%',
      status: 'all',
      sort: 'created',
      order: 'desc',
    });
    expect(wildcard.filteredTotal).toBe(0);

    const none = await repo.list({
      widgetKeyIds: [],
      page: 1,
      size: 20,
      status: 'all',
      sort: 'created',
      order: 'desc',
    });
    expect(none).toEqual({ rows: [], filteredTotal: 0 });
  });

  it('keeps the first resolution and clears it when reopened', async () => {
    const [target] = await db
      .select()
      .from(unansweredQuestions)
      .where(eq(unansweredQuestions.widgetKeyId, ownerKeyId))
      .limit(1);

    await repo.updateStatus(target.id, 'resolved', ownerUuid);
    const first = await repo.findById(target.id);
    await repo.updateStatus(target.id, 'resolved', collaboratorUuid);
    const second = await repo.findById(target.id);

    expect(first?.question.status).toBe('resolved');
    expect(second?.question.resolvedAt?.getTime()).toBe(
      first?.question.resolvedAt?.getTime(),
    );
    expect(second?.question.resolvedByIdpUuid).toBe(ownerUuid);

    await repo.updateStatus(target.id, 'open', ownerUuid);
    const reopened = await repo.findById(target.id);
    expect(reopened?.question.status).toBe('open');
    expect(reopened?.question.resolvedAt).toBeNull();
    expect(reopened?.question.resolvedByIdpUuid).toBeNull();
  });

  it('links a text document and exposes it in the record', async () => {
    const [document] = await db
      .insert(documents)
      .values({
        title: `${testPrefix} 계좌 안내`,
        resourceName: `${testPrefix}-계좌-안내`,
        sourceType: 'text',
        sourceText: '여권과 외국인등록증이 필요합니다.',
        uploadedByIdpUuid: ownerUuid,
        ownerOrganizationId: organizationId,
      })
      .returning();
    documentIds.push(document.id);
    const [target] = await db
      .select()
      .from(unansweredQuestions)
      .where(eq(unansweredQuestions.widgetKeyId, ownerKeyId))
      .limit(1);

    await repo.record({
      sessionId,
      question: target.question,
      answerMessageId: null,
      countOccurrence: true,
    });
    await repo.linkDocument(target.id, document.id, ownerUuid);
    const linked = await repo.findById(target.id);

    // 방금 연결했으므로 해결 이후 재질문으로 판정되면 안 된다.
    expect(linked!.question.resolvedAt!.getTime()).toBeGreaterThanOrEqual(
      linked!.question.lastAskedAt.getTime(),
    );

    expect(linked?.question.status).toBe('resolved');
    expect(linked?.document).toEqual({
      id: document.id,
      title: `${testPrefix} 계좌 안내`,
      resourceName: `${testPrefix}-계좌-안내`,
      status: 'queued',
      sourceType: 'text',
      sourceText: '여권과 외국인등록증이 필요합니다.',
      isActive: true,
    });

    const unlinked = await repo.findById(
      (
        await db
          .select({ id: unansweredQuestions.id })
          .from(unansweredQuestions)
          .where(eq(unansweredQuestions.widgetKeyId, otherKeyId))
      )[0].id,
    );
    expect(unlinked?.document).toBeNull();
  });

  it('requires a source for each document type', async () => {
    await expect(
      db.insert(documents).values({
        title: `${testPrefix} 빈 텍스트`,
        resourceName: `${testPrefix}-empty-text`,
        sourceType: 'text',
        uploadedByIdpUuid: ownerUuid,
        ownerOrganizationId: organizationId,
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(documents).values({
        title: `${testPrefix} PDF 경로 없음`,
        resourceName: `${testPrefix}-no-pdf`,
        uploadedByIdpUuid: ownerUuid,
        ownerOrganizationId: organizationId,
      }),
    ).rejects.toThrow();
  });
});
