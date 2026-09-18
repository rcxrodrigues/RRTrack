-- RECONSTRUIDA. O arquivo original desta migracao se perdeu: o journal a
-- declarava e o snapshot existia, mas o .sql nao estava no repositorio, o que
-- deixava a corrente quebrada entre a 0000 e a 0002 — um banco novo nao subia
-- por `drizzle-kit migrate`.
--
-- Refeita a partir do diff entre os snapshots 0000 e 0002, com a 0002
-- subtraida. Conferida contra PostgreSQL 16 real: aplicar
-- 0000 -> 0001 -> 0002 num banco vazio produz o mesmo schema que
-- src/db/schema.ts — 216 colunas, 55 indices, 48 constraints e 16 valores de
-- enum, todos iguais.
--
-- A ordem FISICA das colunas difere de um banco criado do zero pelo schema,
-- porque coluna adicionada por ALTER TABLE vai para o fim. Isso e o que
-- acontece em qualquer banco que cresceu por migracao, inclusive o de
-- producao, e nao muda nada do que o codigo enxerga.

CREATE TABLE "meta_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"secret" text NOT NULL,
	"token" text,
	"token_expires_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"gateway" text NOT NULL,
	"gateway_order_id" text NOT NULL,
	"click_id" uuid NOT NULL,
	"customer" jsonb,
	"checked_at" timestamp with time zone,
	"checks" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" text,
	"ip" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN "credentials_expire_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN "syncing_since" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN "blocked_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN "usage_pct" real;
--> statement-breakpoint
ALTER TABLE "click_sessions" ADD COLUMN "campaign_id" text;
--> statement-breakpoint
ALTER TABLE "click_sessions" ADD COLUMN "campaign_name" text;
--> statement-breakpoint
ALTER TABLE "click_sessions" ADD COLUMN "adset_id" text;
--> statement-breakpoint
ALTER TABLE "click_sessions" ADD COLUMN "adset_name" text;
--> statement-breakpoint
ALTER TABLE "click_sessions" ADD COLUMN "ad_id" text;
--> statement-breakpoint
ALTER TABLE "click_sessions" ADD COLUMN "ad_name" text;
--> statement-breakpoint
ALTER TABLE "click_sessions" ADD COLUMN "placement" text;
--> statement-breakpoint
ALTER TABLE "click_sessions" ADD COLUMN "country" text;
--> statement-breakpoint
ALTER TABLE "click_sessions" ADD COLUMN "region" text;
--> statement-breakpoint
ALTER TABLE "click_sessions" ADD COLUMN "city" text;
--> statement-breakpoint
ALTER TABLE "dispatches" ADD COLUMN "next_attempt_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "gateway_connections" ADD COLUMN "credentials_expire_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "gateway_connections" ADD COLUMN "fees" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "interest_cents" bigint;
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "description" text;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "count_shipping" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "count_interest" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_seen_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "meta_links" ADD CONSTRAINT "meta_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "meta_links" ADD CONSTRAINT "meta_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "order_claims" ADD CONSTRAINT "order_claims_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "order_claims" ADD CONSTRAINT "order_claims_click_id_click_sessions_click_id_fk" FOREIGN KEY ("click_id") REFERENCES "public"."click_sessions"("click_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "meta_links_secret" ON "meta_links" USING btree ("secret");
--> statement-breakpoint
CREATE INDEX "meta_links_tenant_user" ON "meta_links" USING btree ("tenant_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "claims_tenant_gateway_order" ON "order_claims" USING btree ("tenant_id","gateway","gateway_order_id");
--> statement-breakpoint
CREATE INDEX "claims_reconciliacao" ON "order_claims" USING btree ("tenant_id","checks","checked_at");
--> statement-breakpoint
CREATE INDEX "sessions_user" ON "sessions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "sessions_expira" ON "sessions" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "click_sessions_tenant_ad" ON "click_sessions" USING btree ("tenant_id","ad_id");
--> statement-breakpoint
CREATE INDEX "click_sessions_tenant_campaign" ON "click_sessions" USING btree ("tenant_id","campaign_id");
--> statement-breakpoint
CREATE INDEX "dispatches_proxima_tentativa" ON "dispatches" USING btree ("next_attempt_at");
