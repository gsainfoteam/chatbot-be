ALTER TYPE "public"."document_status" ADD VALUE 'uploading' BEFORE 'queued';--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "processing_token" uuid;