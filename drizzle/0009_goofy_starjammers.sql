CREATE TYPE "public"."document_status" AS ENUM('queued', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"path" varchar(1024) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"content" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(512) NOT NULL,
	"resource_name" varchar(512) NOT NULL,
	"summary" text,
	"gcs_pdf_path" varchar(1024) NOT NULL,
	"status" "document_status" DEFAULT 'queued' NOT NULL,
	"error_message" text,
	"uploaded_by_idp_uuid" varchar(255) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_chunks_document_id_idx" ON "document_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_chunks_document_sort_idx" ON "document_chunks" USING btree ("document_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_resource_name_active_unique" ON "documents" USING btree ("resource_name") WHERE "documents"."is_active" = true;--> statement-breakpoint
CREATE INDEX "documents_status_idx" ON "documents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "documents_uploaded_by_idp_uuid_idx" ON "documents" USING btree ("uploaded_by_idp_uuid");--> statement-breakpoint
CREATE INDEX "documents_is_active_idx" ON "documents" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "documents_created_at_idx" ON "documents" USING btree ("created_at");