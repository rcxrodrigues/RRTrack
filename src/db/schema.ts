/*
 * Schema do RRTrack — multi-loja desde a origem.
 *
 * Toda tabela com dado de negócio carrega `tenantId`, e todo índice começa por
 * ele. Isso não é preciosismo: é o que impede uma consulta mal escrita no painel
 * de mostrar a venda de uma loja para outra, e o que mantém as consultas rápidas
 * quando uma loja sozinha responde por 90% das linhas.
 */

import {
  pgTable, text, timestamp, integer, bigint, boolean, jsonb,
  uuid, index, uniqueIndex, pgEnum, real,
} from "drizzle-orm/pg-core";

export const orderStatusEnum = pgEnum("order_status", [
  "pending", "refused", "paid", "canceled", "refunded", "chargeback",
]);

export const paymentMethodEnum = pgEnum("payment_method", [
  "pix", "credit_card", "debit_card", "boleto", "wallet", "other",
]);

export const dispatchStatusEnum = pgEnum("dispatch_status", [
  "pending", "sent", "failed", "skipped",
]);

/* ---------------------------------------------------------------- contas -- */

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  /* Fuso de apuração. "Horário das vendas" e o corte do dia dependem disto. */
  timezone: text("timezone").notNull().default("America/Sao_Paulo"),
  currency: text("currency").notNull().default("BRL"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  /*
   * PBKDF2-SHA256, guardado como "iteracoes.sal.hash" em base64.
   *
   * Nunca a senha, obviamente — mas também nunca um hash rápido como SHA-256
   * puro: uma placa de vídeo testa bilhões desses por segundo. PBKDF2 é lento
   * de propósito, e o número de iterações fica gravado junto para poder subir
   * com o tempo sem invalidar quem já tem senha.
   */
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
});

/*
 * Sessões de login.
 *
 * Ficam no banco, e não num JWT assinado, por um motivo prático: sessão em
 * JWT não se revoga. Se um token vazar, ou o usuário quiser derrubar os outros
 * aparelhos, não há o que fazer até expirar. Com linha no banco, apagar
 * encerra na hora.
 *
 * O cookie carrega só o hash do token — quem ler o banco não consegue montar
 * um cookie válido a partir dele.
 */
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  userAgent: text("user_agent"),
  ip: text("ip"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("sessions_user").on(t.userId),
  index("sessions_expira").on(t.expiresAt),
]);

export const memberships = pgTable("memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
}, (t) => [uniqueIndex("memberships_tenant_user").on(t.tenantId, t.userId)]);

/*
 * Domínios que enviam eventos. O coletor só aceita origem de um site
 * cadastrado — sem isso, qualquer página na internet poderia despejar
 * eventos falsos numa conta.
 */
export const sites = pgTable("sites", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  domain: text("domain").notNull(),
  /* Subdomínio próprio do coletor, p.ex. "t.minhaloja.com.br". */
  collectorHost: text("collector_host"),
  publicKey: text("public_key").notNull(),
  active: boolean("active").notNull().default(true),
}, (t) => [uniqueIndex("sites_domain").on(t.domain)]);

/* ------------------------------------------------------------- conexões -- */

export const gatewayConnections = pgTable("gateway_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  /* Casa com GatewayAdapter.id — "pagou", "kiwify", "hotmart"... */
  gateway: text("gateway").notNull(),
  label: text("label").notNull(),
  /* Credenciais cifradas em repouso; nunca lidas pelo painel. */
  credentials: jsonb("credentials").$type<Record<string, string>>().notNull().default({}),
  /*
   * Segredo no path da URL do webhook. É a única defesa contra venda forjada
   * em gateway que não assina o payload.
   */
  webhookSecret: text("webhook_secret").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("gateway_conn_tenant").on(t.tenantId)]);

/*
 * Destinos de conversão: para onde as vendas são enviadas.
 * Um tenant pode ter vários por plataforma (dois pixels, duas contas Google).
 */
export const destinations = pgTable("destinations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  label: text("label").notNull(),
  /* Pixel/dataset (Meta), customer id (Google), pixel code (TikTok). */
  externalId: text("external_id").notNull(),
  credentials: jsonb("credentials").$type<Record<string, string>>().notNull().default({}),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  /* Modo de teste da Meta, para validar sem sujar os dados de produção. */
  testEventCode: text("test_event_code"),
  active: boolean("active").notNull().default(true),
}, (t) => [index("destinations_tenant").on(t.tenantId)]);

/* Contas de anúncio, de onde vem o gasto. */
export const adAccounts = pgTable("ad_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  externalId: text("external_id").notNull(),
  label: text("label").notNull(),
  credentials: jsonb("credentials").$type<Record<string, string>>().notNull().default({}),
  active: boolean("active").notNull().default(true),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
}, (t) => [uniqueIndex("ad_accounts_tenant_platform_ext").on(t.tenantId, t.platform, t.externalId)]);

/* ----------------------------------------------------------- atribuição -- */

/*
 * Uma sessão de clique: tudo que o navegador soube da origem.
 *
 * `clickId` é a chave que atravessa o checkout e volta no webhook. É por ela,
 * e não por cookie, que uma venda encontra seu anúncio — cookie não sobrevive
 * ao pulo para o domínio do gateway.
 */
export const clickSessions = pgTable("click_sessions", {
  clickId: uuid("click_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),

  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  utmContent: text("utm_content"),
  utmTerm: text("utm_term"),
  utmId: text("utm_id"),

  fbclid: text("fbclid"),
  gclid: text("gclid"),
  gbraid: text("gbraid"),
  wbraid: text("wbraid"),
  ttclid: text("ttclid"),
  msclkid: text("msclkid"),
  twclid: text("twclid"),
  epik: text("epik"),
  liFatId: text("li_fat_id"),
  kwaiClickId: text("kwai_click_id"),

  fbp: text("fbp"),
  fbc: text("fbc"),

  /*
   * Identificadores da estrutura do anúncio, extraídos das UTMs.
   *
   * Esta é a ponte entre as duas metades do painel. O gasto vem da API da
   * plataforma, chaveado por id de campanha, conjunto e anúncio; a venda vem
   * do webhook, chaveada pelo clickId. Sem o id do anúncio na sessão de
   * clique, não existe ROAS por anúncio — só um total que não se abre.
   *
   * Vêm de variáveis dinâmicas que a plataforma substitui na hora do clique
   * (`{{ad.id}}` na Meta). O id é o que importa: ele não muda quando o
   * anunciante renomeia a campanha, e o nome muda.
   */
  campaignId: text("campaign_id"),
  campaignName: text("campaign_name"),
  adsetId: text("adset_id"),
  adsetName: text("adset_name"),
  adId: text("ad_id"),
  adName: text("ad_name"),
  /* Onde o anúncio apareceu: feed, stories, reels. */
  placement: text("placement"),

  /* Identificador primário nosso, estável no navegador. Vai hasheado no CAPI. */
  externalId: text("external_id"),

  ip: text("ip"),
  userAgent: text("user_agent"),
  landingUrl: text("landing_url"),
  referrer: text("referrer"),

  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("click_sessions_tenant_seen").on(t.tenantId, t.lastSeenAt),
  index("click_sessions_tenant_fbp").on(t.tenantId, t.fbp),
  /* O caminho quente do painel: somar vendas por anúncio para casar com o gasto. */
  index("click_sessions_tenant_ad").on(t.tenantId, t.adId),
  index("click_sessions_tenant_campaign").on(t.tenantId, t.campaignId),
]);

/* Eventos de navegador: view_item, add_to_cart, begin_checkout... */
export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  clickId: uuid("click_id").references(() => clickSessions.clickId, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /* Mesmo id enviado às plataformas — é o que deduplica pixel e servidor. */
  eventId: text("event_id").notNull(),
  valueCents: bigint("value_cents", { mode: "number" }),
  currency: text("currency"),
  pageUrl: text("page_url"),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
}, (t) => [
  uniqueIndex("events_tenant_event_id").on(t.tenantId, t.eventId),
  index("events_tenant_name_time").on(t.tenantId, t.name, t.occurredAt),
  index("events_click").on(t.clickId),
]);

/* ---------------------------------------------------------------- vendas -- */

export const orders = pgTable("orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  gatewayConnectionId: uuid("gateway_connection_id")
    .notNull().references(() => gatewayConnections.id, { onDelete: "cascade" }),

  gatewayOrderId: text("gateway_order_id").notNull(),
  status: orderStatusEnum("status").notNull(),
  currency: text("currency").notNull().default("BRL"),

  grossCents: bigint("gross_cents", { mode: "number" }).notNull(),
  feeCents: bigint("fee_cents", { mode: "number" }),
  shippingCents: bigint("shipping_cents", { mode: "number" }),
  discountCents: bigint("discount_cents", { mode: "number" }),
  /* Custo das mercadorias, somado dos itens. Base do lucro. */
  cogsCents: bigint("cogs_cents", { mode: "number" }),

  paymentMethod: paymentMethodEnum("payment_method").notNull().default("other"),
  installments: integer("installments"),

  /* Comprador, cifrado em repouso. O painel mostra só o necessário. */
  customer: jsonb("customer").$type<Record<string, string>>(),

  /* Sessão que originou a venda, quando o clickId voltou pelo repasse. */
  clickId: uuid("click_id").references(() => clickSessions.clickId, { onDelete: "set null" }),
  /*
   * Como a venda foi atribuída: "click_id" (certeza), "gateway_attribution"
   * (o gateway devolveu UTM), "fbp_match", "email_match" ou "unattributed".
   * O painel precisa mostrar isto — número atribuído por palpite não vale o
   * mesmo que número atribuído por chave.
   */
  attributionMethod: text("attribution_method").notNull().default("unattributed"),

  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("orders_conn_gateway_order").on(t.gatewayConnectionId, t.gatewayOrderId),
  index("orders_tenant_status_time").on(t.tenantId, t.status, t.occurredAt),
  index("orders_tenant_paid").on(t.tenantId, t.paidAt),
  index("orders_click").on(t.clickId),
]);

export const orderItems = pgTable("order_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id").notNull(),
  sku: text("sku"),
  name: text("name").notNull(),
  quantity: integer("quantity").notNull().default(1),
  unitPriceCents: bigint("unit_price_cents", { mode: "number" }).notNull(),
  unitCostCents: bigint("unit_cost_cents", { mode: "number" }),
  variant: text("variant"),
  category: text("category"),
}, (t) => [index("order_items_order").on(t.orderId)]);

/*
 * Toda entrega de webhook recebida, verificada ou não.
 *
 * Serve para deduplicar reentrega, para reprocessar quando um adaptador é
 * corrigido, e para auditar o que chegou quando um número parecer errado.
 */
export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  gatewayConnectionId: uuid("gateway_connection_id").notNull(),
  gatewayEventId: text("gateway_event_id").notNull(),
  verified: boolean("verified").notNull().default(false),
  rawBody: text("raw_body").notNull(),
  headers: jsonb("headers").$type<Record<string, string>>(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  error: text("error"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("deliveries_conn_event").on(t.gatewayConnectionId, t.gatewayEventId),
  index("deliveries_tenant_time").on(t.tenantId, t.receivedAt),
]);

/*
 * Reivindicação de pedido.
 *
 * Nem todo gateway devolve o que a gente mandou. A Appmax é o caso: o webhook
 * de pedido não traz campo de repasse nenhum, e o `tracking` que ela aceita
 * vive no cliente, não no pedido. Sem isso, a venda chega órfã por construção.
 *
 * A saída é a loja avisar: no instante em que ela cria o pedido no gateway, ela
 * já conhece as duas pontas — o clickId que estava no navegador e o id que o
 * gateway acabou de devolver. Uma chamada registra o par aqui, e quando o
 * webhook chegar a junção encontra o dono.
 *
 * Vale para qualquer gateway sem repasse, não só a Appmax.
 */
export const orderClaims = pgTable("order_claims", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  gateway: text("gateway").notNull(),
  gatewayOrderId: text("gateway_order_id").notNull(),
  clickId: uuid("click_id").notNull().references(() => clickSessions.clickId, { onDelete: "cascade" }),

  /*
   * Dados do comprador que a LOJA conhece e o gateway não devolve.
   *
   * Existe por causa de um resultado negativo: nenhum dos três gateways
   * devolve endereço. O pagou.ai chega a aceitar CEP e CPF ao cadastrar o
   * cliente, mas não os devolve em consulta nenhuma — entra e não sai.
   *
   * Só que quem tem esse dado primeiro é a loja: o checkout dela pediu o CEP
   * para calcular frete antes de o gateway existir na história. Aqui ela
   * repassa, e o disparo ganha `ct`, `st`, `zp` e `db` — quatro chaves de
   * correspondência que de outro jeito estariam perdidas.
   *
   * Cifrado em repouso, como qualquer dado pessoal guardado.
   */
  customer: jsonb("customer").$type<Record<string, string>>(),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("claims_tenant_gateway_order").on(t.tenantId, t.gateway, t.gatewayOrderId),
]);

/* ------------------------------------------------------------- disparos -- */

/*
 * Cada envio para uma plataforma. Uma linha por (venda, destino, evento),
 * o que torna impossível mandar a mesma conversão duas vezes mesmo que o
 * gateway reentregue o webhook.
 */
export const dispatches = pgTable("dispatches", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  destinationId: uuid("destination_id").notNull().references(() => destinations.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").references(() => orders.id, { onDelete: "cascade" }),
  eventName: text("event_name").notNull(),
  /* O mesmo event_id mandado à plataforma, para dedupe do lado dela. */
  eventId: text("event_id").notNull(),
  status: dispatchStatusEnum("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  /* Quantas chaves de correspondência foram enviadas — proxy do EMQ. */
  matchKeyCount: integer("match_key_count"),
  matchKeys: jsonb("match_keys").$type<string[]>(),
  requestBody: jsonb("request_body"),
  responseBody: jsonb("response_body"),
  error: text("error"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("dispatches_dest_event").on(t.destinationId, t.eventId, t.eventName),
  index("dispatches_tenant_status").on(t.tenantId, t.status),
  index("dispatches_order").on(t.orderId),
]);

/* ----------------------------------------------------------------- gasto -- */

/*
 * Gasto por dia e por anúncio. O grão é (conta, campanha, conjunto, anúncio,
 * dia) porque é o mais fino que as três plataformas entregam de forma confiável
 * e é o que permite casar com `utm_content` na hora de calcular ROAS por anúncio.
 */
export const adSpendDaily = pgTable("ad_spend_daily", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  adAccountId: uuid("ad_account_id").notNull().references(() => adAccounts.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  /* Dia no fuso do tenant, não em UTC — senão o gasto "vaza" para o dia errado. */
  date: text("date").notNull(),

  campaignId: text("campaign_id"),
  campaignName: text("campaign_name"),
  adsetId: text("adset_id"),
  adsetName: text("adset_name"),
  adId: text("ad_id"),
  adName: text("ad_name"),

  spendCents: bigint("spend_cents", { mode: "number" }).notNull().default(0),
  impressions: bigint("impressions", { mode: "number" }),
  clicks: bigint("clicks", { mode: "number" }),
  /* O que a própria plataforma alega ter gerado — para comparar com o nosso. */
  platformConversions: real("platform_conversions"),
  platformRevenueCents: bigint("platform_revenue_cents", { mode: "number" }),

  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("spend_unique").on(t.adAccountId, t.date, t.adId),
  index("spend_tenant_date").on(t.tenantId, t.date),
]);

/* Custo por SKU, com vigência — o custo muda e o histórico não pode mudar junto. */
export const productCosts = pgTable("product_costs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  sku: text("sku").notNull(),
  unitCostCents: bigint("unit_cost_cents", { mode: "number" }).notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("product_costs_tenant_sku").on(t.tenantId, t.sku, t.effectiveFrom)]);
