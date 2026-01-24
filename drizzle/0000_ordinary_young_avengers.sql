-- Create ENUM types (idempotent)
DO $$ BEGIN
 CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."widget_key_status" AS ENUM('ACTIVE', 'REVOKED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
-- Create tables (idempotent)
CREATE TABLE IF NOT EXISTS "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"widget_key_id" uuid NOT NULL,
	"session_token" text NOT NULL,
	"page_url" varchar(2048) NOT NULL,
	"origin" varchar(512),
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_session_token_unique" UNIQUE("session_token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "widget_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"secret_key" varchar(255) NOT NULL,
	"status" "widget_key_status" DEFAULT 'ACTIVE' NOT NULL,
	"allowed_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "widget_keys_secret_key_unique" UNIQUE("secret_key")
);
--> statement-breakpoint
-- Add foreign key constraints (idempotent)
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_widget_key_id_widget_keys_id_fk" FOREIGN KEY ("widget_key_id") REFERENCES "public"."widget_keys"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
-- Create indexes (idempotent)
CREATE INDEX IF NOT EXISTS "messages_session_id_idx" ON "messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_created_at_idx" ON "messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_session_created_idx" ON "messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_session_token_idx" ON "sessions" USING btree ("session_token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_widget_key_id_idx" ON "sessions" USING btree ("widget_key_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "widget_keys_secret_key_idx" ON "widget_keys" USING btree ("secret_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "widget_keys_status_idx" ON "widget_keys" USING btree ("status");