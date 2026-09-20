CREATE TABLE "rate_limits" (
	"chave" text PRIMARY KEY NOT NULL,
	"contagem" integer DEFAULT 0 NOT NULL,
	"expira_em" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_limits_expira" ON "rate_limits" USING btree ("expira_em");