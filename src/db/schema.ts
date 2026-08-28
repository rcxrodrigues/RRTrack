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
  /* Para quem tem muitos dashboards e não lembra o que cada um cobre. */
  description: text("description"),
  /* Fuso de apuração. "Horário das vendas" e o corte do dia dependem disto. */
  timezone: text("timezone").notNull().default("America/Sao_Paulo"),
  currency: text("currency").notNull().default("BRL"),

  /*
   * O que conta como faturamento.
   *
   * Não é preferência de exibição: muda o ROAS. O gateway cobra do cliente o
   * produto mais o frete mais o juro do parcelamento, e manda o total. Quem
   * repassa frete ao transportador não faturou aquilo — contar infla receita
   * com dinheiro que sai no mesmo dia. Quem embute o frete no preço, contou.
   *
   * O padrão liga os dois porque é o que o gateway informa; desligar é uma
   * decisão contábil de quem opera, e ela precisa ser explícita.
   */
  countShipping: boolean("count_shipping").notNull().default(true),
  countInterest: boolean("count_interest").notNull().default(true),
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

  /*
   * Ajustes do snippet que valem por site.
   *
   * Nasceu de um buraco concreto no funil: numa oferta de resposta direta a
   * página que a pessoa abre JÁ É a página do produto, então "viu o produto" e
   * "visitou o site" são o mesmo acontecimento. Sem dizer isso em algum lugar,
   * o rr.js espera um atributo `data-rr-view` que ninguém escreveu, e a etapa
   * fica zerada para sempre — o que parece campanha ruim, não configuração
   * faltando.
   *
   * O produto declarado aqui também é o que dá VALOR aos eventos. Sem ele,
   * `add_to_cart` e `begin_checkout` chegam à Meta sem preço, e ela só sabe
   * otimizar por volume, nunca por retorno.
   */
  config: jsonb("config").$type<{
    /* A página de entrada é a própria página do produto. */
    viewContentOnLoad?: boolean;
    productId?: string;
    productName?: string;
    productPriceCents?: number;
  }>().notNull().default({}),

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

  /*
   * Quando a credencial vence, se vencer.
   *
   * Nenhum gateway avisa. A chave da pagou.ai expira em 180 dias e o sintoma é
   * silencioso: os webhooks continuam chegando, mas toda confirmação por API
   * passa a falhar, e a venda entra sem o comprador — sem erro em lugar
   * nenhum, só a qualidade do envio caindo. É a loja que sabe a data, então é
   * a loja que preenche; o painel só precisa lembrar antes.
   */
  credentialsExpireAt: timestamp("credentials_expire_at", { withTimezone: true }),

  /*
   * Quanto este gateway cobra, por método de pagamento — ver core/taxas.ts.
   *
   * Só é consultada quando o webhook NÃO informa a taxa. Gateway que manda o
   * valor cobrado tem sempre razão: ele já embute promoção, antecipação e o
   * que foi negociado, e a tabela aqui é estimativa do lojista.
   *
   * Vazia significa "não sei", não "não cobra" — e é o que faz a tela avisar
   * em vez de declarar um lucro que não existe.
   */
  fees: jsonb("fees").$type<Record<string, unknown>>().notNull().default({}),

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

  /*
   * Quando a credencial vence, se vencer.
   *
   * Nenhum gateway avisa. A chave da pagou.ai expira em 180 dias e o sintoma é
   * silencioso: os webhooks continuam chegando, mas toda confirmação por API
   * passa a falhar, e a venda entra sem o comprador — sem erro em lugar
   * nenhum, só a qualidade do envio caindo. É a loja que sabe a data, então é
   * a loja que preenche; o painel só precisa lembrar antes.
   */
  credentialsExpireAt: timestamp("credentials_expire_at", { withTimezone: true }),

  active: boolean("active").notNull().default(true),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),

  /*
   * Proteção contra levar bloqueio da plataforma.
   *
   * As três colunas resolvem três formas diferentes de estourar limite:
   *
   * `syncingSince` — trava contra busca simultânea. Duas abas abertas, ou dois
   *   cliques seguidos, disparariam duas buscas paralelas, e nenhuma das duas
   *   veria a outra porque `lastSyncedAt` só é escrito no fim.
   *
   * `blockedUntil` — quando a plataforma diz que bloqueou e por quanto tempo,
   *   guardamos e paramos. A Meta avisa que insistir durante o bloqueio AUMENTA
   *   a espera; tentar de novo seria piorar de propósito.
   *
   * `usagePct` — quanto da cota já foi consumido, lido do cabeçalho de resposta.
   *   Passando do limite prudente, paramos antes de a plataforma precisar
   *   bloquear. Chegar perto e recuar é diferente de bater e esperar.
   */
  syncingSince: timestamp("syncing_since", { withTimezone: true }),
  blockedUntil: timestamp("blocked_until", { withTimezone: true }),
  usagePct: real("usage_pct"),
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

  /*
   * De onde a pessoa acessou, lido dos cabeçalhos que a Vercel injeta na
   * requisição — `x-vercel-ip-country` e companhia. Não é consulta a serviço
   * externo nem banco de IPs: chega de graça e sem latência.
   *
   * Guardado na sessão em vez de derivado do IP na hora de consultar, porque
   * IP muda: o mesmo visitante volta amanhã de outra rede, e a origem da
   * visita de ontem tem que continuar sendo a de ontem.
   */
  country: text("country"),
  region: text("region"),
  city: text("city"),

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
  /* Juro do parcelamento cobrado do comprador — a Appmax manda como `interest`. */
  interestCents: bigint("interest_cents", { mode: "number" }),
  discountCents: bigint("discount_cents", { mode: "number" }),
  /* Custo das mercadorias, somado dos itens. Base do lucro. */
  cogsCents: bigint("cogs_cents", { mode: "number" }),

  paymentMethod: paymentMethodEnum("payment_method").notNull().default("other"),
  installments: integer("installments"),

  /*
   * Comprador, cifrado em repouso — campo a campo, por core/crypto.
   *
   * O disparo NÃO lê daqui: ele usa o comprador que veio do webhook, ainda em
   * memória. Esta coluna serve para conferência e reprocessamento, então cifrar
   * não custa nenhuma chave de correspondência.
   */
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

  /*
   * Reconciliação: quantas vezes já perguntamos ao gateway por este pedido, e
   * quando foi a última.
   *
   * Existe por causa do carrinho abandonado. Reivindicação sem venda quase
   * sempre é alguém que desistiu, não venda perdida — e sem um teto, cada
   * desistência viraria uma consulta por hora para sempre. Uma loja com mil
   * abandonos por dia bateria na API do gateway o tempo todo sem achar nada, e
   * levaria bloqueio sem estar fazendo nada de errado de propósito.
   */
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  checks: integer("checks").notNull().default(0),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("claims_tenant_gateway_order").on(t.tenantId, t.gateway, t.gatewayOrderId),
  /* A varredura busca por órfã ainda dentro do teto de consultas. */
  index("claims_reconciliacao").on(t.tenantId, t.checks, t.checkedAt),
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

  /*
   * Quando tentar de novo.
   *
   * Sem isto, um disparo que falhasse ficava falhado para sempre: o token cai
   * por uma hora, a plataforma dá 500 num pico, e aquelas conversões somem —
   * sem fila, sem nova tentativa, sem ninguém notar. É perda direta de
   * conversão, que é justamente o que o sistema existe para evitar.
   *
   * Só erro TRANSITÓRIO ganha data. Payload recusado não melhora repetindo, e
   * insistir nele só gasta cota que faria falta ao que tem conserto.
   */
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("dispatches_dest_event").on(t.destinationId, t.eventId, t.eventName),
  /* O caminho quente do reenvio: achar o que está na hora de tentar. */
  index("dispatches_proxima_tentativa").on(t.nextAttemptAt),
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

/* ------------------------------------------------------------- shopify -- */

/*
 * Uma loja da Shopify ligada a esta loja do RRTrack.
 *
 * Serve a dois momentos opostos da mesma venda. Na montagem do checkout, é de
 * onde vêm produto, variante e preço — digitar catálogo à mão em dois lugares
 * é garantir que um dia os dois discordem, e quem descobre é o comprador. Na
 * confirmação do pagamento, é para onde o pedido vai: sem isso a Shopify não
 * sabe que vendeu, não baixa estoque, não emite etiqueta e não avisa ninguém.
 *
 * O token é de app personalizado (Admin API), criado pelo lojista no admin da
 * própria loja, e vive cifrado como qualquer credencial. Precisa dos escopos
 * `read_products`, `write_orders` e `write_customers`.
 */
export const shopifyConnections = pgTable("shopify_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),

  /* Sempre o domínio interno (loja.myshopify.com), nunca o domínio de vitrine:
     o de vitrine muda quando o lojista troca de domínio, este não. */
  shopDomain: text("shop_domain").notNull(),
  /* Nome da loja como a Shopify devolve, só para a tela ter o que mostrar. */
  label: text("label").notNull(),

  credentials: jsonb("credentials").$type<Record<string, string>>().notNull().default({}),

  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  /* Uma loja da Shopify por loja do RRTrack — ligar a mesma duas vezes criaria
     o pedido em duplicidade quando as duas conexões estivessem ativas. */
  uniqueIndex("shopify_tenant_shop").on(t.tenantId, t.shopDomain),
]);

/* ------------------------------------------------------------- checkout -- */

/*
 * Um checkout próprio: a página onde o comprador paga, no nosso domínio.
 *
 * Existe por duas razões que se somam. A primeira é dinheiro — a camada de
 * checkout é a única das três taxas da venda que dá para cortar; gateway e
 * adquirente ninguém escapa. A segunda é atribuição, e é a que vale mais: com
 * o pagamento no nosso domínio, o clickId nunca precisa atravessar o domínio
 * de terceiro e voltar. Some o `sck`, some a reivindicação, some o
 * `unattributed`. A junção deixa de ser costura e passa a ser leitura.
 *
 * O preço mora AQUI e em nenhum outro lugar. Nada que venha do navegador
 * decide valor: o corpo do POST manda quais itens e quantas parcelas, e o
 * servidor busca o preço nesta linha. Checkout que confia no preço enviado
 * pelo cliente é checkout que vende de graça na primeira vez que alguém abrir
 * o inspetor.
 */
export const checkouts = pgTable("checkouts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),

  /* Endereço público: /c/{slug}. Único no sistema todo, não por loja. */
  slug: text("slug").notNull(),
  name: text("name").notNull(),

  /* Por onde o dinheiro entra. A tabela de taxas vem junto, pela conexão. */
  gatewayConnectionId: uuid("gateway_connection_id")
    .notNull().references(() => gatewayConnections.id, { onDelete: "cascade" }),

  /*
   * O site cujo rr.js alimenta a sessão. É o que liga a venda ao clique: a
   * página do checkout carrega o mesmo script, e o clickId que chega no POST
   * é conferido contra as sessões desta loja.
   */
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),

  /*
   * A loja da Shopify que recebe o pedido depois de pago. Nulo é o caso comum:
   * oferta em página própria não tem Shopify nenhuma atrás.
   */
  shopifyConnectionId: uuid("shopify_connection_id")
    .references(() => shopifyConnections.id, { onDelete: "set null" }),

  /* A oferta. Ver acima: preço confiável só o daqui. */
  items: jsonb("items").$type<Array<{
    sku: string;
    name: string;
    quantity: number;
    unitPriceCents: number;
    /* A Appmax exige "digital" ou "physical" por produto, e muda a entrega. */
    digital?: boolean;
    /*
     * A variante na Shopify, quando o item veio de lá. É o que faz o pedido
     * cair no produto certo e baixar o estoque certo — sem ela a linha entra
     * como item avulso, e o estoque não anda.
     */
    shopifyVariantId?: string;
  }>>().notNull().default([]),

  shippingCents: bigint("shipping_cents", { mode: "number" }).notNull().default(0),

  /* Meios aceitos e teto de parcelamento — o comprador não escolhe além disto. */
  methods: jsonb("methods").$type<string[]>().notNull().default(["pix", "credit_card"]),
  maxInstallments: integer("max_installments").notNull().default(12),

  /* Aparência e destino: logo, cor, chamada, para onde vai depois de pagar. */
  config: jsonb("config").$type<Record<string, string>>().notNull().default({}),

  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("checkouts_slug").on(t.slug),
  index("checkouts_tenant").on(t.tenantId),
]);

/*
 * Toda tentativa de pagamento, dando certo ou não.
 *
 * Não é log: é defesa. Uma rota pública que cobra cartão é alvo de teste de
 * cartão roubado — o fraudador dispara centenas de números na sua conta para
 * descobrir quais passam, e quem paga o estorno e leva o bloqueio da adquirente
 * é o lojista, não ele.
 *
 * A contagem precisa estar no banco e não em memória: cada requisição na Vercel
 * pode cair numa instância diferente, e um contador em memória protege apenas
 * contra quem tiver o azar de bater duas vezes no mesmo processo.
 *
 * Serve também para explicar depois por que uma venda não entrou — recusa do
 * antifraude e erro de rede parecem a mesma coisa para quem só olha o painel.
 */
export const checkoutAttempts = pgTable("checkout_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  checkoutId: uuid("checkout_id").notNull().references(() => checkouts.id, { onDelete: "cascade" }),

  ip: text("ip").notNull(),
  paymentMethod: text("payment_method"),
  /* "ok" | "recusado" | "erro" — recusa é do gateway, erro é nosso ou dele. */
  outcome: text("outcome").notNull(),
  gatewayOrderId: text("gateway_order_id"),
  /* Motivo legível, para o painel. Nunca guarda dado de cartão. */
  detail: text("detail"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  /* A consulta do limitador: quantas tentativas deste IP na última janela. */
  index("attempts_ip_time").on(t.ip, t.createdAt),
  index("attempts_checkout_time").on(t.checkoutId, t.createdAt),
]);

/*
 * A venda que passou pelo NOSSO checkout — o que a cobrança sabe e o webhook
 * não vai saber.
 *
 * Existe porque os dois momentos estão separados no tempo e no processo. Quem
 * cobra conhece o comprador inteiro, o endereço e qual variante da Shopify é
 * cada item; quem confirma é o webhook, minutos depois (no pix, muito depois),
 * e chega sabendo só o id do pedido no gateway. Sem este registro no meio, na
 * hora de criar o pedido na Shopify faltaria justamente tudo.
 *
 * Não dá para reaproveitar `order_claims`: ele só nasce quando há clickId
 * válido, e venda sem clique — a pessoa que digitou o endereço direto — tem
 * que chegar na Shopify do mesmo jeito.
 *
 * Os itens são cópia, não referência. O lojista muda preço e produto do
 * checkout a qualquer momento, e o pedido tem que continuar dizendo o que foi
 * vendido naquele dia, não o que a oferta virou depois.
 */
export const checkoutOrders = pgTable("checkout_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  checkoutId: uuid("checkout_id").notNull().references(() => checkouts.id, { onDelete: "cascade" }),

  /* Por onde a cobrança saiu — é o par que o webhook depois usa para achar. */
  gatewayConnectionId: uuid("gateway_connection_id")
    .notNull().references(() => gatewayConnections.id, { onDelete: "cascade" }),
  gatewayOrderId: text("gateway_order_id").notNull(),

  /* Cifrado campo a campo, como todo dado pessoal em repouso. */
  buyer: jsonb("buyer").$type<Record<string, string>>().notNull().default({}),

  items: jsonb("items").$type<Array<{
    sku: string;
    name: string;
    quantity: number;
    unitPriceCents: number;
    shopifyVariantId?: string;
  }>>().notNull().default([]),
  shippingCents: bigint("shipping_cents", { mode: "number" }).notNull().default(0),

  /*
   * O resultado da criação na Shopify. Nulo em `shopifyOrderId` com `syncError`
   * preenchido é o caso que precisa aparecer no painel: o dinheiro entrou e a
   * loja não sabe. Silenciar isso seria vender sem enviar.
   */
  shopifyConnectionId: uuid("shopify_connection_id")
    .references(() => shopifyConnections.id, { onDelete: "set null" }),
  shopifyOrderId: text("shopify_order_id"),
  /* O número que o lojista vê na Shopify (#1042), para casar as duas telas. */
  shopifyOrderName: text("shopify_order_name"),
  shopifySyncedAt: timestamp("shopify_synced_at", { withTimezone: true }),
  syncError: text("sync_error"),
  syncAttempts: integer("sync_attempts").notNull().default(0),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  /*
   * A chave que o webhook procura, e a que impede pedido duplicado na Shopify:
   * uma cobrança, uma linha. Reentrega de webhook cai na linha já sincronizada
   * e não cria nada.
   */
  uniqueIndex("checkout_orders_gateway").on(t.gatewayConnectionId, t.gatewayOrderId),
  index("checkout_orders_tenant_time").on(t.tenantId, t.createdAt),
  /* A varredura do reenvio: o que foi pago e ainda não entrou na Shopify. */
  index("checkout_orders_pendentes").on(t.shopifySyncedAt),
]);
