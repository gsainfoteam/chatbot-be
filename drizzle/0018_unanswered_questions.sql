CREATE TYPE "public"."document_source_type" AS ENUM('pdf', 'text');--> statement-breakpoint
CREATE TYPE "public"."unanswered_question_status" AS ENUM('OPEN', 'RESOLVED', 'DISMISSED');--> statement-breakpoint
CREATE TABLE "unanswered_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"widget_key_id" uuid NOT NULL,
	"question" text NOT NULL,
	"normalized_question" text NOT NULL,
	"language" varchar(8) NOT NULL,
	"ask_count" integer DEFAULT 1 NOT NULL,
	"status" "unanswered_question_status" DEFAULT 'OPEN' NOT NULL,
	"last_session_id" uuid,
	"last_answer_message_id" uuid,
	"resolved_document_id" uuid,
	"resolved_by_idp_uuid" varchar(255),
	"resolved_at" timestamp,
	"first_asked_at" timestamp DEFAULT now() NOT NULL,
	"last_asked_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unanswered_questions_ask_count_positive" CHECK ("unanswered_questions"."ask_count" >= 1)
);
--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "gcs_pdf_path" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "source_type" "document_source_type" DEFAULT 'pdf' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "source_text" text;--> statement-breakpoint
ALTER TABLE "unanswered_questions" ADD CONSTRAINT "unanswered_questions_widget_key_id_widget_keys_id_fk" FOREIGN KEY ("widget_key_id") REFERENCES "public"."widget_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unanswered_questions" ADD CONSTRAINT "unanswered_questions_last_session_id_sessions_id_fk" FOREIGN KEY ("last_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unanswered_questions" ADD CONSTRAINT "unanswered_questions_last_answer_message_id_messages_id_fk" FOREIGN KEY ("last_answer_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unanswered_questions" ADD CONSTRAINT "unanswered_questions_resolved_document_id_documents_id_fk" FOREIGN KEY ("resolved_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "unanswered_questions_widget_key_id_normalized_question_unique" ON "unanswered_questions" USING btree ("widget_key_id","normalized_question");--> statement-breakpoint
CREATE INDEX "unanswered_questions_status_last_asked_idx" ON "unanswered_questions" USING btree ("status","last_asked_at");--> statement-breakpoint
CREATE INDEX "unanswered_questions_last_asked_at_idx" ON "unanswered_questions" USING btree ("last_asked_at");--> statement-breakpoint
CREATE INDEX "unanswered_questions_resolved_document_id_idx" ON "unanswered_questions" USING btree ("resolved_document_id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_source_present" CHECK (("documents"."source_type" = 'pdf' AND "documents"."gcs_pdf_path" IS NOT NULL) OR ("documents"."source_type" = 'text' AND "documents"."source_text" IS NOT NULL));