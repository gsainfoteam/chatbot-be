CREATE TYPE "public"."organization_membership_status" AS ENUM('PENDING', 'ACCEPTED');--> statement-breakpoint
CREATE TYPE "public"."organization_role" AS ENUM('MANAGER', 'MEMBER');--> statement-breakpoint
CREATE TABLE "document_organization_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"shared_by_idp_uuid" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_ownership_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"source_organization_id" uuid NOT NULL,
	"target_organization_id" uuid NOT NULL,
	"actor_idp_uuid" varchar(255) NOT NULL,
	"transferred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invitee_email" varchar(255) NOT NULL,
	"member_idp_uuid" varchar(255),
	"role" "organization_role" DEFAULT 'MEMBER' NOT NULL,
	"status" "organization_membership_status" DEFAULT 'PENDING' NOT NULL,
	"invited_by_idp_uuid" varchar(255) NOT NULL,
	"accepted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by_idp_uuid" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
INSERT INTO "organizations" ("name", "slug", "is_default", "created_by_idp_uuid")
VALUES ('인포팀', 'infoteam', true, NULL)
ON CONFLICT ("slug") DO UPDATE
SET "name" = EXCLUDED."name",
    "is_default" = true,
    "updated_at" = now();--> statement-breakpoint
INSERT INTO "organization_memberships" (
	"organization_id",
	"invitee_email",
	"member_idp_uuid",
	"role",
	"status",
	"invited_by_idp_uuid",
	"accepted_at"
)
SELECT
	o."id",
	lower(trim(a."email")),
	a."idp_uuid",
	'MANAGER'::"organization_role",
	'ACCEPTED'::"organization_membership_status",
	a."idp_uuid",
	now()
FROM "admins" a
JOIN "organizations" o ON o."slug" = 'infoteam'
WHERE a."role" = 'SUPER_ADMIN'
  AND NOT EXISTS (
    SELECT 1
    FROM "organization_memberships" existing
    WHERE existing."organization_id" = o."id"
      AND (
        existing."invitee_email" = lower(trim(a."email"))
        OR existing."member_idp_uuid" = a."idp_uuid"
      )
  );--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "owner_organization_id" uuid;--> statement-breakpoint
UPDATE "documents"
SET "owner_organization_id" = (
	SELECT "id" FROM "organizations" WHERE "slug" = 'infoteam'
)
WHERE "owner_organization_id" IS NULL;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "documents" WHERE "owner_organization_id" IS NULL) THEN
		RAISE EXCEPTION 'documents.owner_organization_id backfill failed';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "owner_organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "document_organization_shares" ADD CONSTRAINT "document_organization_shares_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_organization_shares" ADD CONSTRAINT "document_organization_shares_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_ownership_transfers" ADD CONSTRAINT "document_ownership_transfers_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_ownership_transfers" ADD CONSTRAINT "document_ownership_transfers_source_organization_id_organizations_id_fk" FOREIGN KEY ("source_organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_ownership_transfers" ADD CONSTRAINT "document_ownership_transfers_target_organization_id_organizations_id_fk" FOREIGN KEY ("target_organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_organization_shares_document_id_idx" ON "document_organization_shares" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_organization_shares_organization_id_idx" ON "document_organization_shares" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_organization_shares_document_id_organization_id_unique" ON "document_organization_shares" USING btree ("document_id","organization_id");--> statement-breakpoint
CREATE INDEX "document_ownership_transfers_document_id_idx" ON "document_ownership_transfers" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_ownership_transfers_source_organization_id_idx" ON "document_ownership_transfers" USING btree ("source_organization_id");--> statement-breakpoint
CREATE INDEX "document_ownership_transfers_target_organization_id_idx" ON "document_ownership_transfers" USING btree ("target_organization_id");--> statement-breakpoint
CREATE INDEX "organization_memberships_organization_id_idx" ON "organization_memberships" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "organization_memberships_member_idp_uuid_status_idx" ON "organization_memberships" USING btree ("member_idp_uuid","status");--> statement-breakpoint
CREATE INDEX "organization_memberships_invitee_email_status_idx" ON "organization_memberships" USING btree ("invitee_email","status");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_memberships_organization_id_invitee_email_unique" ON "organization_memberships" USING btree ("organization_id","invitee_email") WHERE "organization_memberships"."status" = 'PENDING';--> statement-breakpoint
CREATE UNIQUE INDEX "organization_memberships_organization_id_member_idp_uuid_unique" ON "organization_memberships" USING btree ("organization_id","member_idp_uuid") WHERE "organization_memberships"."member_idp_uuid" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_single_default_unique" ON "organizations" USING btree ("is_default") WHERE "organizations"."is_default" = true;--> statement-breakpoint
CREATE INDEX "organizations_created_by_idp_uuid_idx" ON "organizations" USING btree ("created_by_idp_uuid");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_organization_id_organizations_id_fk" FOREIGN KEY ("owner_organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_owner_organization_id_idx" ON "documents" USING btree ("owner_organization_id");
