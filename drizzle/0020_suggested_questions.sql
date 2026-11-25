CREATE TYPE "public"."suggested_question_source" AS ENUM('ADMIN', 'AI');--> statement-breakpoint
CREATE TYPE "public"."suggested_question_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "notice_question_ingestions" (
	"widget_key_id" uuid NOT NULL,
	"notice_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "notice_question_ingestions_pkey" PRIMARY KEY("widget_key_id","notice_id")
);
--> statement-breakpoint
CREATE TABLE "suggested_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"widget_key_id" uuid NOT NULL,
	"question" text NOT NULL,
	"normalized_question" text NOT NULL,
	"prompt" text,
	"source" "suggested_question_source" DEFAULT 'ADMIN' NOT NULL,
	"status" "suggested_question_status" DEFAULT 'PENDING' NOT NULL,
	"notice_id" integer,
	"notice_title" varchar(500),
	"created_by_idp_uuid" varchar(255),
	"reviewed_by_idp_uuid" varchar(255),
	"reviewed_at" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "suggested_questions_question_length" CHECK (char_length("suggested_questions"."question") BETWEEN 1 AND 100)
);
--> statement-breakpoint
ALTER TABLE "notice_question_ingestions" ADD CONSTRAINT "notice_question_ingestions_widget_key_id_widget_keys_id_fk" FOREIGN KEY ("widget_key_id") REFERENCES "public"."widget_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggested_questions" ADD CONSTRAINT "suggested_questions_widget_key_id_widget_keys_id_fk" FOREIGN KEY ("widget_key_id") REFERENCES "public"."widget_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "suggested_questions_widget_key_id_normalized_question_unique" ON "suggested_questions" USING btree ("widget_key_id","normalized_question");--> statement-breakpoint
CREATE INDEX "suggested_questions_serving_idx" ON "suggested_questions" USING btree ("widget_key_id","status","source");--> statement-breakpoint
CREATE INDEX "suggested_questions_notice_id_idx" ON "suggested_questions" USING btree ("notice_id");