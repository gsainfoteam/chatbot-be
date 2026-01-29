CREATE TABLE "uploaded_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(512) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"uploaded_by_idp_uuid" varchar(255) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "uploaded_resources_uploaded_by_idp_uuid_idx" ON "uploaded_resources" USING btree ("uploaded_by_idp_uuid");--> statement-breakpoint
CREATE INDEX "uploaded_resources_is_active_idx" ON "uploaded_resources" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "uploaded_resources_created_at_idx" ON "uploaded_resources" USING btree ("created_at");
