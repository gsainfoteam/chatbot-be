import { readFileSync } from 'fs';
import { join } from 'path';

describe('per-user question limit migration', () => {
  // 저널에 등록된(실제로 적용되는) 마이그레이션만 태그로 읽는다. 번호가 바뀌어도 깨지지 않는다.
  const drizzleDir = join(process.cwd(), 'drizzle');
  const journal = JSON.parse(
    readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { tag: string }[] };
  const migrationSql = journal.entries
    .map(({ tag }) => readFileSync(join(drizzleDir, `${tag}.sql`), 'utf8'))
    .join('\n');

  // 열·제약·인덱스는 대상 테이블까지 포함한 문장으로 확인한다.
  it('adds nullable limit columns to widget keys', () => {
    expect(migrationSql).toContain(
      'ALTER TABLE "widget_keys" ADD COLUMN "question_limit" integer;',
    );
    expect(migrationSql).toContain(
      'ALTER TABLE "widget_keys" ADD COLUMN "question_limit_window_seconds" integer;',
    );
  });

  it('keeps the limit pair either unset or within the allowed ranges', () => {
    expect(migrationSql).toContain(
      'ALTER TABLE "widget_keys" ADD CONSTRAINT "widget_keys_question_limit_check" CHECK (("widget_keys"."question_limit" IS NULL AND "widget_keys"."question_limit_window_seconds" IS NULL) OR ("widget_keys"."question_limit" IS NOT NULL AND "widget_keys"."question_limit_window_seconds" IS NOT NULL AND "widget_keys"."question_limit" BETWEEN 1 AND 10000 AND "widget_keys"."question_limit_window_seconds" BETWEEN 60 AND 2592000))',
    );
  });

  it('stores the hashed client id on sessions with a lookup index', () => {
    expect(migrationSql).toContain(
      'ALTER TABLE "sessions" ADD COLUMN "end_user_key" varchar(64);',
    );
    expect(migrationSql).toContain(
      'CREATE INDEX "sessions_end_user_key_idx" ON "sessions" USING btree ("end_user_key") WHERE "sessions"."end_user_key" IS NOT NULL;',
    );
  });
});
