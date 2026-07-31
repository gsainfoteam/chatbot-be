ALTER TABLE "documents" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
CREATE INDEX "documents_expires_at_idx" ON "documents" USING btree ("expires_at");