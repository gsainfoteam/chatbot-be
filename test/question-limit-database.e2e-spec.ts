import type { HttpException } from '@nestjs/common';
import { inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { messages, sessions, widgetKeys, type Database } from '../src/db';
import * as schema from '../src/db/schema';
import { MessageRole } from '../src/common/dto/chat-message-input.dto';
import { ChatService } from '../src/chat/services/chat.service';
import type { UsageService } from '../src/usage/usage.service';

/**
 * 실행 예:
 *   QUESTION_LIMIT_TEST_DB=true DB_NAME=..._test \
 *   bun run test:e2e -- question-limit-database
 * 마이그레이션이 적용된 테스트 DB가 필요하다.
 */
const describeDatabase =
  process.env.QUESTION_LIMIT_TEST_DB === 'true' ? describe : describe.skip;

describeDatabase('Per-user question limit (database e2e)', () => {
  const prefix = `ql-e2e-${Date.now()}`;
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let service: ChatService;
  let limitedKeyId: string;
  let otherKeyId: string;
  let windowKeyId: string;
  let sessionCount = 0;

  beforeAll(async () => {
    const database = process.env.DB_NAME ?? '';
    if (!database.endsWith('_test')) {
      throw new Error(
        'Question limit database E2E requires DB_NAME ending in _test',
      );
    }
    client = postgres({
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 5432),
      database,
      username: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
      max: 6,
      // created_at은 DB 시계로 저장되므로 비UTC 세션에서도 기간 계산이 맞는지 확인한다.
      connection: { TimeZone: 'Asia/Seoul' },
    });
    db = drizzle(client, { schema });
    service = new ChatService(db as unknown as Database, {} as UsageService);

    const keys = await db
      .insert(widgetKeys)
      .values([
        ...['limited', 'other'].map((name) => ({
          name: `${prefix} ${name}`,
          secretKey: `${prefix}-${name}`,
          questionLimit: 2,
          questionLimitWindowSeconds: 3600,
        })),
        {
          name: `${prefix} window`,
          secretKey: `${prefix}-window`,
          questionLimit: 1,
          questionLimitWindowSeconds: 60,
        },
      ])
      .returning();
    [limitedKeyId, otherKeyId, windowKeyId] = keys.map((key) => key.id);
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .delete(widgetKeys)
      .where(inArray(widgetKeys.id, [limitedKeyId, otherKeyId, windowKeyId]));
    await client.end();
  });

  async function session(
    endUserKey: string | null,
    widgetKeyId = limitedKeyId,
  ) {
    const [row] = await db
      .insert(sessions)
      .values({
        widgetKeyId,
        endUserKey,
        sessionToken: `${prefix}-session-${++sessionCount}`,
        pageUrl: 'http://localhost/chat',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning();
    return row.id;
  }

  const ask = (sessionId: string) =>
    service.createMessage(sessionId, {
      role: MessageRole.USER,
      content: 'question',
    });

  const rejection = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: unknown) => error as HttpException,
    );

  it('counts questions across sessions that share an end user key', async () => {
    const first = await session('user-shared');
    const second = await session('user-shared');
    await ask(first);
    await ask(second);

    const error = await rejection(ask(second));

    expect(error?.getStatus()).toBe(429);
    expect(error?.getResponse()).toMatchObject({
      limit: 2,
      windowSeconds: 3600,
    });
    const { retryAfterSeconds } = error!.getResponse() as {
      retryAfterSeconds: number;
    };
    expect(retryAfterSeconds).toBeGreaterThan(3590);
    expect(retryAfterSeconds).toBeLessThanOrEqual(3600);
  });

  it('keeps other users, widget keys and anonymous sessions separate', async () => {
    await ask(await session('user-full'));
    await ask(await session('user-full'));

    await expect(ask(await session('user-other'))).resolves.toMatchObject({
      role: 'user',
    });
    await expect(
      ask(await session('user-full', otherKeyId)),
    ).resolves.toMatchObject({ role: 'user' });

    const anonymous = await session(null);
    await ask(anonymous);
    await ask(anonymous);
    expect((await rejection(ask(anonymous)))?.getStatus()).toBe(429);
    await expect(ask(await session(null))).resolves.toMatchObject({
      role: 'user',
    });
  });

  it('ignores questions older than the window', async () => {
    const id = await session('user-old');
    await db.insert(messages).values(
      [1, 2].map(() => ({
        sessionId: id,
        role: 'user' as const,
        content: 'old question',
        createdAt: sql`localtimestamp - interval '2 hours'`,
      })),
    );

    await expect(ask(id)).resolves.toMatchObject({ role: 'user' });
  });

  it('measures the window after waiting for the lock, not from the transaction start', async () => {
    // 한도 1·기간 60초에 59.5초 전 질문이 있다. 다른 요청이 같은 사용자 잠금을 1.5초 쥐는 동안
    // 그 질문이 기간을 벗어나므로, 잠금을 기다린 질문은 허용되고 잠금이 풀린 뒤의 시각으로 저장되어야 한다.
    const id = await session('user-wait', windowKeyId);
    await db.insert(messages).values({
      sessionId: id,
      role: 'user',
      content: 'old question',
      createdAt: sql`localtimestamp - interval '59.5 seconds'`,
    });
    let lockTaken = () => {};
    const taken = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });
    let releasedAt = '';
    const holder = db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${'user-wait'}, 0))`,
      );
      lockTaken();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const [row] = await tx.execute<{ releasedAt: string }>(
        sql`SELECT clock_timestamp()::timestamp::text AS "releasedAt"`,
      );
      releasedAt = row.releasedAt;
    });
    // holder가 잠금을 잡기 전에 실패하면 기다리지 않고 바로 실패하게 한다.
    await Promise.race([taken, holder]);

    const [waited] = await Promise.all([ask(id), holder]);

    // 저장 시각은 잠금이 풀리기 직전의 DB 시각과 비교해 이후 조회 지연과 상관없이 확인한다.
    const [saved] = await db
      .select({
        afterRelease: sql<boolean>`${messages.createdAt} >= ${releasedAt}::timestamp`,
      })
      .from(messages)
      .where(inArray(messages.id, [waited.id]));
    expect(saved.afterRelease).toBe(true);
    expect((await rejection(ask(id)))?.getStatus()).toBe(429);
  });

  it('lets exactly the limit through when one user asks concurrently', async () => {
    const ids = await Promise.all(
      [1, 2, 3, 4, 5].map(() => session('user-concurrent')),
    );

    const results = await Promise.allSettled(ids.map(ask));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    for (const result of results.filter((r) => r.status === 'rejected')) {
      const reason = result.reason as HttpException;
      expect(reason.getStatus()).toBe(429);
    }
  });

  it('rejects a half-set or out-of-range limit in the database', async () => {
    const invalidLimits: [number | null, number | null][] = [
      [5, null],
      [null, 60],
      [0, 60],
      [10001, 60],
      [1, 59],
      [1, 2592001],
    ];
    for (const [questionLimit, questionLimitWindowSeconds] of invalidLimits) {
      const error = await db
        .insert(widgetKeys)
        .values({
          name: `${prefix} invalid`,
          secretKey: `${prefix}-invalid-${questionLimit}-${questionLimitWindowSeconds}`,
          questionLimit,
          questionLimitWindowSeconds,
        })
        .then(
          () => null,
          (e: { cause?: { constraint_name?: string } }) => e,
        );
      expect(error?.cause?.constraint_name).toBe(
        'widget_keys_question_limit_check',
      );
    }
  });
});
