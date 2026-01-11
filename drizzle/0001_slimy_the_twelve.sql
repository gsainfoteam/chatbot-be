CREATE TYPE "public"."admin_role" AS ENUM('SUPER_ADMIN', 'ADMIN');--> statement-breakpoint
CREATE TABLE "admins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idp_uuid" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"role" "admin_role" DEFAULT 'ADMIN' NOT NULL,
	"last_login_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "admins_idp_uuid_unique" UNIQUE("idp_uuid"),
	CONSTRAINT "admins_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "widget_keys" ADD COLUMN "created_by_idp_uuid" varchar(255);--> statement-breakpoint
CREATE INDEX "admins_idp_uuid_idx" ON "admins" USING btree ("idp_uuid");--> statement-breakpoint
CREATE INDEX "admins_email_idx" ON "admins" USING btree ("email");--> statement-breakpoint
CREATE INDEX "widget_keys_created_by_idp_uuid_idx" ON "widget_keys" USING btree ("created_by_idp_uuid");