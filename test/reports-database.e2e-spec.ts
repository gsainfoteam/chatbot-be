import { inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  messageFeedbacks,
  messages,
  sessions,
  unansweredQuestions,
  widgetKeys,
  type Database,
} from '../src/db';
import * as schema from '../src/db/schema';
import { ReportsRepository } from '../src/reports/reports.repository';

/**
 * 실행 예:
 *   REPORTS_TEST_DB=true DB_NAME=..._test \
 *   bun run test:e2e -- reports-database
 * 마이그레이션이 적용된 테스트 DB가 필요하다.
 */
const describeDatabase =
  process.env.REPORTS_TEST_DB === 'true' ? describe : describe.skip;

// KST 시각을 created_at과 같은 형태(DB 세션 시간대의 timestamp)로 바꾼다.
const at = (kst: string) =>
  sql`((${kst}::timestamp AT TIME ZONE 'Asia/Seoul') AT TIME ZONE current_setting('TimeZone'))`;

describeDatabase('Monthly report queries (database e2e)', () => {
  const prefix = `report-e2e-${Date.now()}`;
  const october = { start: '2026-10-01', end: '2026-11-01' };
  const november = { start: '2026-11-01', end: '2026-12-01' };
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let repo: ReportsRepository;
  let keyA: string;
  let keyB: string;
  let keyC: string;

  beforeAll(async () => {
    const database = process.env.DB_NAME ?? '';
    if (!database.endsWith('_test')) {
      throw new Error('Report database E2E requires DB_NAME ending in _test');
    }
    client = postgres({
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 5432),
      database,
      username: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
      max: 3,
      // created_at은 DB 시계로 저장되므로 비UTC 세션에서도 KST 월 경계가 맞는지 확인한다.
      connection: { TimeZone: 'Asia/Seoul' },
    });
    db = drizzle(client, { schema });
    repo = new ReportsRepository(db as unknown as Database);

    [keyA, keyB, keyC] = (
      await db
        .insert(widgetKeys)
        .values(
          ['a', 'b', 'c'].map((name) => ({
            name: `${prefix} ${name}`,
            secretKey: `${prefix}-${name}`,
          })),
        )
        .returning()
    ).map((key) => key.id);

    const [s1, s2, s3, sB, sC] = (
      await db
        .insert(sessions)
        .values(
          [
            { widgetKeyId: keyA, endUserKey: 'user-1' },
            { widgetKeyId: keyA, endUserKey: 'user-1' },
            { widgetKeyId: keyA, endUserKey: null },
            { widgetKeyId: keyB, endUserKey: 'user-1' },
            { widgetKeyId: keyC, endUserKey: null },
          ].map((s, i) => ({
            ...s,
            sessionToken: `${prefix}-session-${i}`,
            pageUrl: 'http://localhost/chat',
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          })),
        )
        .returning()
    ).map((s) => s.id);

    const message = async (
      sessionId: string,
      role: 'user' | 'assistant',
      content: string,
      kst: string,
      metadata: Record<string, unknown> | null = null,
    ) => {
      const [row] = await db
        .insert(messages)
        .values({ sessionId, role, content, metadata, createdAt: at(kst) })
        .returning();
      return row.id;
    };
    const evaluation = (outcome: string, totalMs: number, tokens: number) => ({
      evaluation: { outcome, totalMs },
      usage: { total_tokens: tokens },
    });

    // 10월, 키 A
    await message(s1, 'user', 'GIST 학식 메뉴?', '2026-10-10 09:00:00');
    const a1 = await message(
      s1,
      'assistant',
      'answer',
      '2026-10-10 09:00:05',
      evaluation('answered', 1000, 100),
    );
    await message(s1, 'user', '도서관 운영시간', '2026-10-10 09:10:00');
    const a2 = await message(
      s1,
      'assistant',
      'answer',
      '2026-10-10 09:10:05',
      evaluation('unanswered', 3000, 300),
    );
    // 다음 질문보다 늦게 저장된 재생성 답변. 질문은 원래 답변(a1) 기준으로 찾아야 한다.
    const r1 = await message(
      s1,
      'assistant',
      'regenerated',
      '2026-10-10 09:20:00',
      {
        ...evaluation('answered', 2000, 200),
        regeneratedFromMessageId: a1,
        regeneratedFromFeedback: 'BAD',
      },
    );
    await message(s2, 'user', 'gist 학식 메뉴', '2026-10-31 23:59:58');
    const a3 = await message(
      s2,
      'assistant',
      'legacy answer',
      '2026-10-31 23:59:59',
    );
    await message(s3, 'user', '셔틀 시간표', '2026-10-20 12:00:00');
    await message(
      s3,
      'assistant',
      'answer',
      '2026-10-20 12:00:03',
      evaluation('unanswered', 4000, 0),
    );
    // 11월, 키 A (월 시작 경계)
    await message(s3, 'user', '11월 질문', '2026-11-01 00:00:00');
    await message(
      s3,
      'assistant',
      'answer',
      '2026-11-01 00:00:02',
      evaluation('answered', 500, 50),
    );
    // 10월, 키 B (키 A 보고서에 섞이면 안 된다)
    await message(sB, 'user', '다른 키 질문', '2026-10-15 10:00:00');
    const aB = await message(
      sB,
      'assistant',
      'answer',
      '2026-10-15 10:00:05',
      evaluation('unanswered', 100, 10),
    );

    // 10월, 키 C: 위젯 클라이언트가 POST /messages로 저장한 잘못된 metadata
    await message(sC, 'user', '깨진 메타데이터 질문', '2026-10-12 10:00:00');
    const aC = await message(sC, 'assistant', 'forged', '2026-10-12 10:00:01', {
      usage: { total_tokens: 'x' },
      evaluation: { outcome: 'unanswered', totalMs: 1.5 },
      regeneratedFromMessageId: 'not-a-uuid',
    });

    await db.insert(messageFeedbacks).values([
      { messageId: a1, rating: 'BAD' },
      { messageId: r1, rating: 'BAD' },
      { messageId: a3, rating: 'BAD' },
      { messageId: a2, rating: 'GOOD' },
      { messageId: aB, rating: 'BAD' },
      { messageId: aC, rating: 'BAD' },
    ]);

    const unanswered = (
      widgetKeyId: string,
      question: string,
      created: string,
      resolved: string | null,
    ) => ({
      widgetKeyId,
      question,
      normalizedQuestion: question,
      language: 'KO',
      createdAt: at(created),
      resolvedAt: resolved ? at(resolved) : null,
    });
    await db
      .insert(unansweredQuestions)
      .values([
        unanswered(keyA, 'q-oct', '2026-10-05 10:00:00', '2026-10-25 10:00:00'),
        unanswered(keyA, 'q-sep', '2026-09-30 23:59:59', '2026-10-01 00:00:00'),
        unanswered(keyA, 'q-nov', '2026-11-01 00:00:00', null),
        unanswered(
          keyB,
          'q-other',
          '2026-10-10 10:00:00',
          '2026-10-11 10:00:00',
        ),
      ]);
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .delete(widgetKeys)
      .where(inArray(widgetKeys.id, [keyA, keyB, keyC]));
    await client.end();
  });

  it('summarizes one KST month for one widget key', async () => {
    await expect(repo.summarize(keyA, october)).resolves.toEqual({
      questions: 4,
      answers: 5,
      users: 2,
      tokens: 600,
      avgResponseMs: 2500,
      good: 1,
      bad: 3,
      regenerated: 1,
    });
  });

  it('puts the first instant of a month into that month only', async () => {
    await expect(repo.summarize(keyA, november)).resolves.toMatchObject({
      questions: 1,
      answers: 1,
      users: 1,
    });
  });

  it('counts outcomes with missing records as null', async () => {
    const outcomes = await repo.countOutcomes(keyA, october);
    expect(
      Object.fromEntries(outcomes.map((o) => [o.outcome, o.count])),
    ).toEqual({
      answered: 2,
      unanswered: 2,
      null: 1,
    });
  });

  it('finds the question of each bad answer, using the original answer for regenerations', async () => {
    await expect(
      repo.listProblemQuestions(keyA, october, 'bad'),
    ).resolves.toEqual([
      'gist 학식 메뉴',
      'GIST 학식 메뉴?',
      'GIST 학식 메뉴?',
    ]);
  });

  it('finds the questions answered without references', async () => {
    await expect(
      repo.listProblemQuestions(keyA, october, 'unanswered'),
    ).resolves.toEqual(['셔틀 시간표', '도서관 운영시간']);
  });

  it('counts unanswered questions created and resolved within the month', async () => {
    await expect(repo.countUnansweredChanges(keyA, october)).resolves.toEqual({
      created: 1,
      resolved: 2,
    });
  });

  it('skips malformed client-written metadata instead of failing', async () => {
    await expect(repo.summarize(keyC, october)).resolves.toMatchObject({
      questions: 1,
      answers: 1,
      tokens: 0,
      avgResponseMs: null,
      bad: 1,
    });
    for (const kind of ['bad', 'unanswered'] as const) {
      await expect(
        repo.listProblemQuestions(keyC, october, kind),
      ).resolves.toEqual(['깨진 메타데이터 질문']);
    }
  });

  it('keeps other widget keys out of the report', async () => {
    await expect(repo.summarize(keyB, october)).resolves.toMatchObject({
      questions: 1,
      answers: 1,
      bad: 1,
    });
    await expect(repo.countUnansweredChanges(keyB, october)).resolves.toEqual({
      created: 1,
      resolved: 1,
    });
  });
});
