import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

describe('per-user question limit migration', () => {
  const migrationSql = readdirSync(join(process.cwd(), 'drizzle'))
    .filter((file) => file.endsWith('.sql'))
    .map((file) => readFileSync(join(process.cwd(), 'drizzle', file), 'utf8'))
    .join('\n');

  // 번호가 바뀌어도(다른 PR의 마이그레이션이 먼저 들어오는 경우) 깨지지 않도록 모든 SQL에서 찾되, 테이블까지 확인한다.
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
