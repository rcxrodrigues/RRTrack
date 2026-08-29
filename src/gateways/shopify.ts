/*
 * Adaptador da Shopify.
 *
 * Diferente de todos os outros deste diretório: a Shopify não é um gateway de
 * pagamento, é a loja inteira. O webhook de pedido dela traz o que nenhum
 * gateway brasileiro traz — endereço completo do comprador, com CEP, cidade,
 * estado e país. São quatro chaves de correspondência a mais no CAPI da Meta,
 * sem precisar do `/api/claim` que a Appmax e a pagou obrigam.
 *
 * Cinco coisas aqui não são óbvias, e cada uma erra o número em silêncio se
 * for lida do jeito natural:
 *
 * 1. DINHEIRO É DECIMAL, NÃO CENTAVO. `total_price` chega "129.95" — reais e
 *    centavos, não centavos. O `cents()` dos outros adaptadores olha se o
 *    texto é só dígito e, sendo, aceita como já-centavos; com a Shopify isso
 *    transformaria "12995" (se um dia vier sem ponto) em R$ 129,95 ou o
 *    contrário. Aqui a conversão é sempre decimal → menor unidade, e passa
 *    por core/moeda.ts para respeitar moeda sem centavo, como o iene.
 *
 * 2. `shop_money`, NUNCA `presentment_money`. Uma loja inglesa vendendo para
 *    um americano registra o pedido com presentment em USD e shop em GBP. O
 *    faturamento da loja é o shop; usar o presentment jogaria dólar dentro de
 *    uma loja em libra — exatamente o que a coluna `currency` do gasto passou
 *    a impedir do lado do anúncio.
 *
 * 3. `note_attributes` É LISTA, não objeto: `[{name, value}]`. É onde o nosso
 *    clickId viaja — a Shopify não tem `sck`. Lido como objeto, o repasse sai
 *    vazio e toda venda vira `unattributed`.
 *
 * 4. `landing_site` GUARDA AS UTMs. É o caminho da primeira página que a
 *    pessoa abriu, com a query inteira. Serve de atribuição secundária quando
 *    o clickId não resolve, e é de graça — já está no payload.
 *
 * 5. `refunds/create` É IGNORADO. O corpo é um Refund e traz o que foi
 *    devolvido, não o total do pedido — gravá-lo encolheria o pedido para o
 *    valor do estorno, sem volta. O estorno entra por `orders/updated`, que
 *    é assinatura obrigatória. A explicação inteira está no `parse`.
 *
 * A Shopify NÃO informa a taxa de processamento no webhook de pedido. Por isso
 * `feeCents` fica indefinido de propósito: indefinido deixa a tabela de taxas
 * estimar, enquanto zero informado pelo gateway venceria a tabela e o lucro
 * apareceria maior do que é.
 */

import type {
  GatewayAdapter, WebhookRequest, VerifyResult, GatewayCredentials,
} from "./types";
import type {
  CanonicalOrder, OrderStatus, PaymentMethod, OrderItem, Cents,
} from "../core/types";
import { paraMenorUnidade } from "../core/moeda";

const enc = new TextEncoder();

/*
 * `financial_status` do pedido. É o campo que fala de DINHEIRO — o
 * `fulfillment_status`, que fala de entrega, não diz nada sobre faturamento.
 *
 * `authorized` e `partially_paid` ficam em pendente porque o dinheiro ainda
 * não é seu: autorização é reserva no cartão, e reserva expira. Contar como
 * pago inflaria o faturamento com venda que pode nunca se concretizar.
 */
const STATUS_MAP: Record<string, OrderStatus> = {
  pending: "pending",
  authorized: "pending",
  partially_paid: "pending",
  paid: "paid",
  partially_refunded: "refunded",
  refunded: "refunded",
  voided: "canceled",
  expired: "refused",
};

/*
 * A Shopify diz o nome comercial do meio de pagamento, não a categoria. A
 * lista de `payment_gateway_names` vem como "shopify_payments", "paypal",
 * "mercado_pago", e por aí. O que importa para a tabela de taxas é a
 * categoria, então casamos por pedaço do nome.
 */
function metodoDe(nomes: string[]): PaymentMethod {
  const todos = nomes.join(" ").toLowerCase();
  if (todos.includes("pix")) return "pix";
  if (todos.includes("boleto") || todos.includes("bank_slip")) return "boleto";
  if (todos.includes("paypal") || todos.includes("wallet")
    || todos.includes("apple_pay") || todos.includes("google_pay")) return "wallet";
  if (todos.includes("debit")) return "debit_card";
  /*
   * Pagamento manual, na entrega ou por transferencia nao passa por
   * adquirente. Cair em "credit_card" faria a tabela de taxas descontar uma
   * taxa que ninguem cobrou, e o lucro sairia menor do que foi.
   */
  if (todos.includes("manual") || todos.includes("cash")
    || todos.includes("cod") || todos.includes("bank_deposit")
    || todos.includes("money_order")) return "other";
  /*
   * `shopify_payments` e a maioria dos apps de gateway são cartão de crédito.
   * O padrão é crédito, e não "other", porque "other" não tem linha na tabela
   * de taxas — a estimativa nem chegaria a ser feita.
   */
  if (todos) return "credit_card";
  return "other";
}

function pick(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => {
    if (acc && typeof acc === "object" && k in (acc as object)) {
      return (acc as Record<string, unknown>)[k];
    }
    return undefined;
  }, obj);
}

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  return undefined;
}

/*
 * Lê um par valor+moeda do formato `*_set` da Shopify, caindo no campo solto
 * quando o `_set` não veio.
 *
 *   total_price_set: { shop_money: { amount: "129.95", currency_code: "BRL" } }
 *
 * O `_set` é a fonte boa porque carrega a moeda junto do número. O campo solto
 * (`total_price`) está sempre na moeda da loja também, mas depende do
 * `currency` do topo — e depender de dois campos que podem discordar é como se
 * erra a moeda sem perceber.
 */
function dinheiroDe(
  raiz: unknown,
  campoSet: string,
  campoSolto: string,
  moedaPadrao: string,
): Cents | undefined {
  const shop = pick(raiz, `${campoSet}.shop_money`);
  if (shop) {
    const valor = pick(shop, "amount");
    if (valor !== undefined && valor !== null) {
      const moeda = str(pick(shop, "currency_code")) ?? moedaPadrao;
      return paraMenorUnidade(valor, moeda);
    }
  }
  const solto = pick(raiz, campoSolto);
  if (solto === undefined || solto === null) return undefined;
  return paraMenorUnidade(solto, moedaPadrao);
}

/*
 * A moeda DA LOJA, que é a que interessa.
 *
 * `currency` no topo do pedido é a moeda de apresentação — a que o comprador
 * viu. `total_price_set.shop_money.currency_code` é a que o lojista recebe. Numa
 * loja inglesa que vendeu para um americano, o primeiro diz USD e o segundo
 * GBP; registrar a venda em USD colocaria dólar no faturamento de uma loja em
 * libra, e a soma com o gasto em libra não significaria nada.
 */
function moedaDaLoja(pedido: unknown): string {
  return (
    str(pick(pedido, "total_price_set.shop_money.currency_code"))
    ?? str(pick(pedido, "currency"))
    ?? "BRL"
  ).toUpperCase();
}

function parseItems(pedido: unknown, moeda: string): OrderItem[] {
  const raw = pick(pedido, "line_items");
  if (!Array.isArray(raw)) return [];
  return raw.map((p): OrderItem => ({
    /*
     * O SKU do lojista, não o `variant_id` da Shopify — é o SKU que casa com
     * a tabela de custo de produto. Quando o lojista não preencheu, cai no
     * id da variante para ao menos agrupar.
     */
    sku: str(pick(p, "sku")) ?? str(pick(p, "variant_id")) ?? str(pick(p, "product_id")),
    name: str(pick(p, "title")) ?? "produto",
    quantity: Number(pick(p, "quantity") ?? 1) || 1,
    unitPriceCents: dinheiroDe(p, "price_set", "price", moeda) ?? 0,
    variant: str(pick(p, "variant_title")),
    category: str(pick(p, "product_type")) ?? str(pick(p, "vendor")),
  }));
}

/*
 * Onde o clickId viaja na Shopify.
 *
 * `note_attributes` é o campo livre por pedido, e é o único que sobrevive do
 * carrinho até o webhook. A loja põe lá o nosso clickId (no tema, junto do
 * rr.js) e ele volta aqui. `cart_token` e `checkout_token` entram por serem
 * identificadores estáveis do mesmo checkout — não são UUID, então não
 * confundem a busca por clickId, e ajudam a depurar venda que não casou.
 */
function parsePassthrough(pedido: unknown): Record<string, string> {
  const out: Record<string, string> = {};

  const attrs = pick(pedido, "note_attributes");
  if (Array.isArray(attrs)) {
    for (const a of attrs) {
      const nome = str(pick(a, "name"));
      const valor = str(pick(a, "value"));
      if (nome && valor) out[`note.${nome}`] = valor;
    }
  }

  for (const campo of ["cart_token", "checkout_token", "checkout_id", "token"]) {
    const v = str(pick(pedido, campo));
    if (v) out[campo] = v;
  }

  /*
   * `landing_site` costuma trazer a query inteira da primeira visita. Se o
   * clickId foi na URL, ele está aqui — e a busca por UUID acha, porque olha
   * valor por valor. Quebramos a query em pares para cada valor ser visto
   * sozinho, senão o UUID viria grudado no resto da URL e não casaria.
   */
  const landing = str(pick(pedido, "landing_site"));
  if (landing) {
    out.landing_site = landing;
    const q = landing.indexOf("?");
    if (q !== -1) {
      for (const [k, v] of new URLSearchParams(landing.slice(q + 1))) {
        if (v) out[`landing.${k}`] = v;
      }
    }
  }
  return out;
}

/* As UTMs da primeira visita, lidas do `landing_site`. */
function parseAtribuicao(pedido: unknown): CanonicalOrder["attribution"] {
  const landing = str(pick(pedido, "landing_site"));
  const referrer = str(pick(pedido, "referring_site"));
  if (!landing && !referrer) return undefined;

  const q = landing?.indexOf("?") ?? -1;
  const p = q !== -1 && landing
    ? new URLSearchParams(landing.slice(q + 1))
    : new URLSearchParams();

  const ou = (k: string) => p.get(k) ?? undefined;

  return {
    utmSource: ou("utm_source"),
    utmMedium: ou("utm_medium"),
    utmCampaign: ou("utm_campaign"),
    utmContent: ou("utm_content"),
    utmTerm: ou("utm_term"),
    /* A Shopify não guarda fbp/fbc; o que dá para recuperar é o id do clique. */
    fbc: ou("fbclid") ? `fb.1.${Date.now()}.${ou("fbclid")}` : undefined,
    gclid: ou("gclid"),
    ttclid: ou("ttclid"),
    landingUrl: landing,
    referrer,
  };
}

/*
 * O comprador, montado a partir de três lugares.
 *
 * O endereço de entrega é a fonte preferida por ser o que a pessoa digitou
 * com cuidado; o de cobrança entra quando não há entrega (produto digital).
 * É daqui que saem `ct`, `st`, `zp` e `country` do CAPI — as chaves que
 * nenhum gateway brasileiro entrega.
 */
function parseCliente(pedido: unknown): CanonicalOrder["customer"] {
  const end = pick(pedido, "shipping_address") ?? pick(pedido, "billing_address");
  const cli = pick(pedido, "customer");

  const nome = [
    str(pick(end, "first_name")) ?? str(pick(cli, "first_name")),
    str(pick(end, "last_name")) ?? str(pick(cli, "last_name")),
  ].filter(Boolean).join(" ") || str(pick(end, "name")) || undefined;

  const c = {
    name: nome,
    email: str(pick(pedido, "email")) ?? str(pick(cli, "email"))
      ?? str(pick(pedido, "contact_email")),
    phone: str(pick(pedido, "phone")) ?? str(pick(end, "phone")) ?? str(pick(cli, "phone")),
    city: str(pick(end, "city")),
    /*
     * `province_code` é a sigla ("SP", "CA"); `province` é o nome por extenso.
     * A Meta normaliza os dois, mas a sigla casa melhor — é o que o pixel do
     * navegador manda.
     */
    state: str(pick(end, "province_code")) ?? str(pick(end, "province")),
    zip: str(pick(end, "zip")),
    country: str(pick(end, "country_code")) ?? str(pick(end, "country")),
    /*
     * A Shopify não coleta CPF, nascimento nem gênero por padrão. Quando a
     * loja coleta, costuma guardar em note_attributes ou num metafield — e aí
     * chega pelo `/api/claim`, não por aqui.
     */
  };

  return Object.values(c).some((v) => v !== undefined) ? c : undefined;
}

/** Compara dois bytes a byte, sem sair no primeiro que difere. */
function igualEmTempoConstante(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export const shopifyAdapter: GatewayAdapter = {
  id: "shopify",
  label: "Shopify",
  /* A loja inteira, nao so o pagamento — e e dai que vem o endereco. */
  especie: "plataforma",
  credenciais: [
    { chave: "signingSecret", rotulo: "Segredo de assinatura do webhook",
      dica: "Opcional. Configurações → Notificações → Webhooks, no rodapé da página. Sem ele a venda entra igual, só sem prova de que o POST veio da sua loja." },
    /*
     * Os dois de baixo servem so a reconciliacao — buscar na Admin API um
     * pedido cujo webhook se perdeu. O webhook em si nao precisa deles.
     */
    { chave: "shopDomain", rotulo: "Domínio da loja (opcional)",
      dica: "minhaloja.myshopify.com — só para reconciliar venda cujo webhook se perdeu." },
    { chave: "accessToken", rotulo: "Token da Admin API (opcional)" },
  ],
  /* A Shopify não tem `src`/`sck`: o campo livre por pedido é este. */
  passthroughFields: ["note_attributes"],

  async verify(
    req: WebhookRequest,
    _secret: string,
    credentials?: GatewayCredentials,
  ): Promise<VerifyResult> {
    /*
     * A chave é o segredo do webhook da Shopify — o "client secret" do app,
     * ou o segredo mostrado ao criar a notificação no admin. NÃO é o segredo
     * do caminho da nossa URL: aquele diz quem pode bater na porta, este prova
     * que quem bateu foi a Shopify. Trocar um pelo outro rejeita todo webhook
     * verdadeiro com 401, e o sintoma é venda que simplesmente não chega.
     */
    const chave = credentials?.webhookSecret ?? credentials?.apiSecret
      ?? credentials?.signingSecret;
    if (!chave) return { ok: false, reason: "sem_assinatura" };

    const header = req.headers["x-shopify-hmac-sha256"];
    if (!header) return { ok: false, reason: "assinatura ausente" };

    /*
     * A Shopify manda em BASE64, não em hexadecimal como a MillionsPay. Ler
     * como hex daria "assinatura malformada" em todo webhook legítimo.
     */
    let assinatura: Uint8Array;
    try {
      const bin = atob(header.trim());
      assinatura = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    } catch {
      return { ok: false, reason: "assinatura malformada" };
    }
    if (assinatura.length !== 32) return { ok: false, reason: "assinatura malformada" };

    try {
      const key = await crypto.subtle.importKey(
        "raw", enc.encode(chave),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
      );
      /*
       * Assina e compara, em vez de usar `verify` do WebCrypto: precisamos que
       * a comparação seja em tempo constante e que o tamanho errado não jogue
       * exceção no meio do caminho.
       *
       * O HMAC é sobre o corpo CRU. Reserializar o JSON muda um espaço que
       * seja e a assinatura não fecha mais.
       */
      const esperado = new Uint8Array(
        await crypto.subtle.sign("HMAC", key, enc.encode(req.rawBody)),
      );
      return igualEmTempoConstante(esperado, assinatura)
        ? { ok: true }
        : { ok: false, reason: "assinatura inválida" };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "falha ao verificar" };
    }
  },

  async parse(req: WebhookRequest): Promise<CanonicalOrder | null> {
    /*
     * Notificação de teste do admin da Shopify traz um pedido de mentira, com
     * cara de pedido de verdade. Entrando, vira faturamento que nunca houve —
     * e o pior é que parece plausível.
     */
    const ehTeste = req.headers["x-shopify-test"];
    if (ehTeste !== undefined && ehTeste.toLowerCase() !== "false") return null;

    const topico = (req.headers["x-shopify-topic"] ?? "").toLowerCase();
    const body = JSON.parse(req.rawBody) as Record<string, unknown>;

    /* O id da entrega, para deduplicar reentrega. Muda a cada tentativa. */
    const idEntrega = str(req.headers["x-shopify-webhook-id"]);

    /*
     * `refunds/create` É IGNORADO DE PROPÓSITO, e isto é a parte importante.
     *
     * O corpo de um Refund não traz o total do pedido — traz o que foi
     * devolvido. E o registro de venda sobrescreve `grossCents` a cada
     * atualização: um estorno parcial de R$ 20 num pedido de R$ 129,95
     * regravaria o pedido como R$ 20,00. Pior, ficaria assim para sempre,
     * porque "estornado" tem posto mais alto que "pago" e nenhum evento
     * posterior consegue corrigir o valor.
     *
     * Faturamento histórico encolhendo sozinho é o pior defeito possível
     * aqui: ninguém desconfia de um número menor.
     *
     * O estorno chega por `orders/updated`, que vem com `financial_status`
     * "refunded" ou "partially_refunded" E com o `total_price` verdadeiro. É
     * por isso que a assinatura de `orders/updated` não é opcional na hora de
     * configurar — sem ela, estorno não aparece. Falta visível é melhor que
     * número corrompido em silêncio.
     */
    if (topico.startsWith("refunds/")) return null;

    /* Fora pedido e estorno, nada aqui é venda: carrinho, cliente, produto. */
    if (!topico.startsWith("orders/") && !body.financial_status) return null;

    const gatewayOrderId = str(body.id);
    if (!gatewayOrderId) return null;

    const financeiro = (str(body.financial_status) ?? "").toLowerCase();
    let status = STATUS_MAP[financeiro];

    /*
     * Cancelamento vem em `cancelled_at`, e não no `financial_status` — um
     * pedido cancelado antes de pagar continua com `financial_status: pending`.
     * Sem esta linha ele ficaria pendente para sempre na tela.
     *
     * Estorno ganha do cancelamento: os dois excluem a venda do faturamento,
     * mas "estornado" diz que o dinheiro entrou e voltou, que é mais preciso.
     */
    if (str(body.cancelled_at) && status !== "refunded") status = "canceled";

    /*
     * `orders/cancelled` sem financial_status reconhecido ainda é um
     * cancelamento; `orders/paid` sem status reconhecido ainda é uma venda
     * paga. O tópico é a última palavra quando o corpo não diz.
     */
    if (!status) {
      if (topico === "orders/cancelled") status = "canceled";
      else if (topico === "orders/paid") status = "paid";
      else return null;
    }

    const moeda = moedaDaLoja(body);
    const items = parseItems(body, moeda);

    /*
     * `total_price` já inclui frete, imposto e desconto — é o que o comprador
     * pagou, que é a definição de `grossCents`. Somar os itens daria menos, e
     * a diferença apareceria como frete comido pelo lucro.
     */
    const bruto = dinheiroDe(body, "total_price_set", "total_price", moeda)
      ?? items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0);

    const quando = str(body.cancelled_at)
      ?? str(body.processed_at) ?? str(body.created_at);
    const d = quando ? new Date(quando) : new Date();

    const gateways = pick(body, "payment_gateway_names");
    const nomes = Array.isArray(gateways)
      ? gateways.map((g) => str(g) ?? "")
      : [str(body.gateway) ?? ""];

    return {
      gatewayOrderId,
      gatewayEventId: idEntrega ?? `${gatewayOrderId}:${status}`,
      status,
      currency: moeda,
      grossCents: bruto,
      /* Ver a nota no topo: a Shopify não informa taxa no webhook de pedido. */
      feeCents: undefined,
      shippingCents: dinheiroDe(
        body, "total_shipping_price_set", "total_shipping_price", moeda,
      ),
      discountCents: dinheiroDe(body, "total_discounts_set", "total_discounts", moeda),
      paymentMethod: metodoDe(nomes),
      items,
      customer: parseCliente(body),
      attribution: parseAtribuicao(body),
      passthrough: parsePassthrough(body),
      occurredAt: Number.isNaN(d.getTime()) ? new Date() : d,
      raw: body,
    };
  },

  /*
   * Consulta o pedido na Admin API.
   *
   * Serve para reconciliar venda cujo webhook se perdeu. Confirmação de origem
   * não precisa disto: a Shopify assina, então o HMAC já prova.
   */
  async fetchOrder(orderId: string, cred: GatewayCredentials): Promise<CanonicalOrder | null> {
    const loja = cred.shopDomain ?? cred.accountId;
    const token = cred.accessToken ?? cred.apiKey;
    if (!loja || !token) return null;

    /*
     * A versão vai no caminho e não é opcional. A Shopify aposenta cada versão
     * doze meses depois de lançada; quando a API começar a responder 400 ou
     * 406 reclamando de versão, é este valor que sobe — por isso ele é
     * credencial, e não constante escondida no código.
     */
    const versao = cred.apiVersion ?? "2025-10";
    const dominio = loja.replace(/^https?:\/\//, "").replace(/\/+$/, "");

    const res = await fetch(
      `https://${dominio}/admin/api/${versao}/orders/${orderId}.json`,
      { headers: { "x-shopify-access-token": token, accept: "application/json" } },
    );

    /* 404 é resposta, não falha: o pedido não existe. */
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Shopify respondeu ${res.status} ao consultar o pedido`);

    const j = await res.json() as Record<string, unknown>;
    const pedido = (j.order ?? j) as Record<string, unknown>;

    const financeiro = (str(pedido.financial_status) ?? "").toLowerCase();
    let status = STATUS_MAP[financeiro];
    if (str(pedido.cancelled_at) && status !== "refunded") status = "canceled";
    if (!status) return null;

    const moeda = moedaDaLoja(pedido);
    const items = parseItems(pedido, moeda);

    const quando = str(pedido.processed_at) ?? str(pedido.created_at);
    const d = quando ? new Date(quando) : new Date();

    const gateways = pick(pedido, "payment_gateway_names");
    const nomes = Array.isArray(gateways)
      ? gateways.map((g) => str(g) ?? "")
      : [str(pedido.gateway) ?? ""];

    return {
      gatewayOrderId: str(pedido.id) ?? orderId,
      gatewayEventId: `api:${orderId}:${status}`,
      status,
      currency: moeda,
      grossCents: dinheiroDe(pedido, "total_price_set", "total_price", moeda) ?? 0,
      shippingCents: dinheiroDe(
        pedido, "total_shipping_price_set", "total_shipping_price", moeda,
      ),
      discountCents: dinheiroDe(pedido, "total_discounts_set", "total_discounts", moeda),
      paymentMethod: metodoDe(nomes),
      items,
      customer: parseCliente(pedido),
      attribution: parseAtribuicao(pedido),
      passthrough: parsePassthrough(pedido),
      occurredAt: Number.isNaN(d.getTime()) ? new Date() : d,
      raw: j,
    };
  },

  /*
   * Sem `enrich`, e isso é uma afirmação e não um esquecimento: o webhook da
   * Shopify já vem com comprador e endereço completos. A Appmax precisa de
   * uma consulta extra porque manda o pedido sem comprador nenhum; aqui não
   * há o que buscar.
   */
};
