import { readFileSync } from 'fs';
import { join } from 'path';

describe('organization ownership migration', () => {
  const sql = readFileSync(
    join(process.cwd(), 'drizzle', '0014_unique_dracula.sql'),
    'utf8',
  );

  it('creates independent organization roles and all ownership tables', () => {
    expect(sql).toContain(
      `CREATE TYPE "public"."organization_role" AS ENUM('MANAGER', 'MEMBER')`,
    );
    expect(sql).toContain('CREATE TABLE "organizations"');
    expect(sql).toContain('CREATE TABLE "organization_memberships"');
    expect(sql).toContain('CREATE TABLE "document_organization_shares"');
    expect(sql).toContain('CREATE TABLE "document_ownership_transfers"');
  });

  it('creates infoteam and backfills every document before NOT NULL', () => {
    const insert = sql.indexOf("VALUES ('인포팀', 'infoteam', true, NULL)");
    const addNullable = sql.indexOf('ADD COLUMN "owner_organization_id" uuid;');
    const backfill = sql.indexOf('UPDATE "documents"');
    const verify = sql.indexOf(
      "RAISE EXCEPTION 'documents.owner_organization_id backfill failed'",
    );
    const notNull = sql.indexOf(
      'ALTER COLUMN "owner_organization_id" SET NOT NULL',
    );
    expect(sql).toContain('ON CONFLICT ("slug") DO UPDATE');
    expect(insert).toBeGreaterThan(-1);
    expect(addNullable).toBeGreaterThan(insert);
    expect(backfill).toBeGreaterThan(addNullable);
    expect(verify).toBeGreaterThan(backfill);
    expect(notNull).toBeGreaterThan(verify);
  });

  it('backfills existing SUPER_ADMINs as accepted default MANAGERs', () => {
    expect(sql).toContain(`WHERE a."role" = 'SUPER_ADMIN'`);
    expect(sql).toContain(`'MANAGER'::"organization_role"`);
    expect(sql).toContain(`'ACCEPTED'::"organization_membership_status"`);
  });

  it('enforces single default and membership/share uniqueness', () => {
    expect(sql).toContain('organizations_single_default_unique');
    expect(sql).toContain(
      'organization_memberships_organization_id_member_idp_uuid_unique',
    );
    expect(sql).toContain(
      'organization_memberships_organization_id_invitee_email_unique" ON "organization_memberships" USING btree ("organization_id","invitee_email") WHERE "organization_memberships"."status" = \'PENDING\'',
    );
    expect(sql).toContain(
      'document_organization_shares_document_id_organization_id_unique',
    );
  });
});
