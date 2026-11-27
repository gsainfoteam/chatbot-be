CREATE TYPE "public"."suggested_question_source" AS ENUM('ADMIN', 'AI');--> statement-breakpoint
CREATE TYPE "public"."suggested_question_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "notice_question_ingestions" (
	"notice_id" integer PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suggested_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
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
CREATE UNIQUE INDEX "suggested_questions_normalized_question_unique" ON "suggested_questions" USING btree ("normalized_question");--> statement-breakpoint
CREATE INDEX "suggested_questions_serving_idx" ON "suggested_questions" USING btree ("status","source");--> statement-breakpoint
CREATE INDEX "suggested_questions_notice_id_idx" ON "suggested_questions" USING btree ("notice_id");