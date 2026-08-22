CREATE TYPE "public"."dispatch_status" AS ENUM('pending', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending', 'refused', 'paid', 'canceled', 'refunded', 'chargeback');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('pix', 'credit_card', 'debit_card', 'boleto', 'wallet', 'other');--> statement-breakpoint
CREATE TABLE "ad_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"label" text NOT NULL,
	"credentials" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ad_spend_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"date" text NOT NULL,
	"campaign_id" text,
	"campaign_name" text,
	"adset_id" text,
	"adset_name" text,
	"ad_id" text,
	"ad_name" text,
	"spend_cents" bigint DEFAULT 0 NOT NULL,
	"impressions" bigint,
	"clicks" bigint,
	"platform_conversions" real,
	"platform_revenue_cents" bigint,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "click_sessions" (
	"click_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"site_id" uuid,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"utm_term" text,
	"utm_id" text,
	"fbclid" text,
	"gclid" text,
	"gbraid" text,
	"wbraid" text,
	"ttclid" text,
	"msclkid" text,
	"twclid" text,
	"epik" text,
	"li_fat_id" text,
	"kwai_click_id" text,
	"fbp" text,
	"fbc" text,
	"external_id" text,
	"ip" text,
	"user_agent" text,
	"landing_url" text,
	"referrer" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"label" text NOT NULL,
	"external_id" text NOT NULL,
	"credentials" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"test_event_code" text,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"order_id" uuid,
	"event_name" text NOT NULL,
	"event_id" text NOT NULL,
	"status" "dispatch_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"match_key_count" integer,
	"match_keys" jsonb,
	"request_body" jsonb,
	"response_body" jsonb,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"click_id" uuid,
	"name" text NOT NULL,
	"event_id" text NOT NULL,
	"value_cents" bigint,
	"currency" text,
	"page_url" text,
	"payload" jsonb,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gateway_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"gateway" text NOT NULL,
	"label" text NOT NULL,
	"credentials" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"webhook_secret" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sku" text,
	"name" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"unit_cost_cents" bigint,
	"variant" text,
	"category" text
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"gateway_connection_id" uuid NOT NULL,
	"gateway_order_id" text NOT NULL,
	"status" "order_status" NOT NULL,
	"currency" text DEFAULT 'BRL' NOT NULL,
	"gross_cents" bigint NOT NULL,
	"fee_cents" bigint,
	"shipping_cents" bigint,
	"discount_cents" bigint,
	"cogs_cents" bigint,
	"payment_method" "payment_method" DEFAULT 'other' NOT NULL,
	"installments" integer,
	"customer" jsonb,
	"click_id" uuid,
	"attribution_method" text DEFAULT 'unattributed' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"unit_cost_cents" bigint NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"collector_host" text,
	"public_key" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"timezone" text DEFAULT 'America/Sao_Paulo' NOT NULL,
	"currency" text DEFAULT 'BRL' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"gateway_connection_id" uuid NOT NULL,
	"gateway_event_id" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"raw_body" text NOT NULL,
	"headers" jsonb,
	"processed_at" timestamp with time zone,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_spend_daily" ADD CONSTRAINT "ad_spend_daily_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_spend_daily" ADD CONSTRAINT "ad_spend_daily_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "click_sessions" ADD CONSTRAINT "click_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "click_sessions" ADD CONSTRAINT "click_sessions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_destination_id_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_click_id_click_sessions_click_id_fk" FOREIGN KEY ("click_id") REFERENCES "public"."click_sessions"("click_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_connections" ADD CONSTRAINT "gateway_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_gateway_connection_id_gateway_connections_id_fk" FOREIGN KEY ("gateway_connection_id") REFERENCES "public"."gateway_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_click_id_click_sessions_click_id_fk" FOREIGN KEY ("click_id") REFERENCES "public"."click_sessions"("click_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_costs" ADD CONSTRAINT "product_costs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_accounts_tenant_platform_ext" ON "ad_accounts" USING btree ("tenant_id","platform","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "spend_unique" ON "ad_spend_daily" USING btree ("ad_account_id","date","ad_id");--> statement-breakpoint
CREATE INDEX "spend_tenant_date" ON "ad_spend_daily" USING btree ("tenant_id","date");--> statement-breakpoint
CREATE INDEX "click_sessions_tenant_seen" ON "click_sessions" USING btree ("tenant_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "click_sessions_tenant_fbp" ON "click_sessions" USING btree ("tenant_id","fbp");--> statement-breakpoint
CREATE INDEX "destinations_tenant" ON "destinations" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatches_dest_event" ON "dispatches" USING btree ("destination_id","event_id","event_name");--> statement-breakpoint
CREATE INDEX "dispatches_tenant_status" ON "dispatches" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "dispatches_order" ON "dispatches" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_tenant_event_id" ON "events" USING btree ("tenant_id","event_id");--> statement-breakpoint
CREATE INDEX "events_tenant_name_time" ON "events" USING btree ("tenant_id","name","occurred_at");--> statement-breakpoint
CREATE INDEX "events_click" ON "events" USING btree ("click_id");--> statement-breakpoint
CREATE INDEX "gateway_conn_tenant" ON "gateway_connections" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_tenant_user" ON "memberships" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "order_items_order" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_conn_gateway_order" ON "orders" USING btree ("gateway_connection_id","gateway_order_id");--> statement-breakpoint
CREATE INDEX "orders_tenant_status_time" ON "orders" USING btree ("tenant_id","status","occurred_at");--> statement-breakpoint
CREATE INDEX "orders_tenant_paid" ON "orders" USING btree ("tenant_id","paid_at");--> statement-breakpoint
CREATE INDEX "orders_click" ON "orders" USING btree ("click_id");--> statement-breakpoint
CREATE INDEX "product_costs_tenant_sku" ON "product_costs" USING btree ("tenant_id","sku","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_domain" ON "sites" USING btree ("domain");--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_conn_event" ON "webhook_deliveries" USING btree ("gateway_connection_id","gateway_event_id");--> statement-breakpoint
CREATE INDEX "deliveries_tenant_time" ON "webhook_deliveries" USING btree ("tenant_id","received_at");