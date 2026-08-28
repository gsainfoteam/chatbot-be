CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN "embedding" vector(3072);
