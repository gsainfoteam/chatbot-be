CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN "embedding" vector(1536);--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN "embedding_model" varchar(255);--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN "embedding_content_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN "embedded_at" timestamp;
