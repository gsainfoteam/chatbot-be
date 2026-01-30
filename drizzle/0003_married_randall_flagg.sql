CREATE TABLE "usage_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"widget_key_id" uuid NOT NULL,
	"date" date NOT NULL,
	"domain" varchar(512) NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"total_requests" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "uploaded_resources" ALTER COLUMN "metadata" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_widget_key_id_widget_keys_id_fk" FOREIGN KEY ("widget_key_id") REFERENCES "public"."widget_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_daily_widget_key_date_idx" ON "usage_daily" USING btree ("widget_key_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_daily_widget_key_id_date_domain_unique" ON "usage_daily" USING btree ("widget_key_id","date","domain");