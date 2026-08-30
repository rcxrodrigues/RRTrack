/*
 * Adaptador do pagou.ai.
 *
 * Serve de referência para os demais: mostra o que um adaptador precisa
 * resolver — envelope, dedupe, status, centavos, atribuição e repasse.
 *
 * Duas particularidades deste gateway, ambas documentadas por eles:
 *
 * 1. Não há assinatura HMAC. `verify` devolve `sem_assinatura`, e a venda
 *    entra marcada como não verificada — a barreira é só o segredo no caminho
 *    da URL.
 *
 *    A confirmação vem de `fetchOrder`, que consulta
 *    `GET /v2/transactions/{id}` — o caminho que a própria documentação deles
 *    recomenda quando o resultado é incerto. O roteador compara o que o
 *    webhook disse com o que a API respondeu antes de contabilizar.
 *
 * 2. O CPF e o endereço não vêm no webhook — mas EXISTEM na API, e por muito
 *    tempo este comentário afirmou o contrário. Estão em
 *    `/v2/customers/{buyer.id}`, um recurso que ninguém tinha chamado: CEP,
 *    cidade, estado, país, documento e nascimento. É o que o `enrich` no fim
 *    deste arquivo busca, e é a diferença entre um Purchase com três chaves
 *    de correspondência e um com oito.
 *
 * Em compensação, o bloco `data.attribution` já traz utm_*, fbc, fbp, gclid,
 * ttclid, src e sck. É o gateway mais generoso em atribuição que apareceu até
 * agora, e serve de fonte secundária quando o clickId não resolve.
 *
 * NÃO TROQUE ISTO POR UMA CREDENCIAL DE API.
 *
 * Desde que a entrada por API passou a entender o formato da Utmify, é
 * tentador unificar tudo por lá — um endereço só, um token só. Para a pagou.ai
 * isso seria um downgrade em duas frentes, e nenhuma delas daria erro:
 *
 *   1. O `trackingParameters` da Utmify tem src, sck e utm_*, e NÃO tem fbc
 *      nem fbp. São as duas chaves de correspondência mais valiosas que
 *      existem para tráfego pago, e o webhook nativo daqui traz as duas.
 *   2. `fetchOrder` deixaria de ser chamado. Como este gateway não assina, a
 *      venda passaria a entrar sem confirmação nenhuma — e venda forjada por
 *      quem descobrir o token custa caro: o painel mente e a Meta otimiza
 *      para uma conversão que não existiu.
 *
 * A credencial de API é para gateway que NÃO tem webhook configurável. Este
 * tem.
 */

import type {
  GatewayAdapter, WebhookRequest, VerifyResult, GatewayCredentials,
} from "./types";
import type {
  CanonicalOrder, OrderStatus, PaymentMethod, OrderItem, Cents,
} from "../core/types";

/** `transaction.paid` e `paid` chegam nas duas formas conforme a versão. */
const STATUS_MAP: Record<string, OrderStatus> = {
  created: "pending",
  pending: "pending",
  processing: "pending",
  three_ds_required: "pending",
  waiting_payment: "pending",
  paid: "paid",
  approved: "paid",
  refused: "refused",
  failed: "refused",
  cancelled: "canceled",
  canceled: "canceled",
  refunded: "refunded",
  partially_refunded: "refunded",
  chargedback: "chargeback",
  chargeback: "chargeback",
};

const METHOD_MAP: Record<string, PaymentMethod> = {
  pix: "pix",
  credit_card: "credit_card",
  creditcard: "credit_card",
  card: "credit_card",
  debit_card: "debit_card",
  boleto: "boleto",
  voucher: "wallet",
};

function pick(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => {
    if (acc && typeof acc === "object" && k in (acc as object)) {
      return (acc as Record<string, unknown>)[k];
    }
    return undefined;
  }, obj);
}

/*
 * "null" e "undefined" ESCRITOS COMO TEXTO são ausência.
 *
 * A pagou.ai manda `"phone": "null"` — a palavra, não o nulo do JSON. Aceitar
 * como texto fazia duas coisas ruins: guardava um telefone de zero dígitos, e
 * — pior — fazia o `enrich` achar que já tinha telefone e NÃO buscar o de
 * verdade no cadastro do comprador. O dado existia dos dois lados e se perdia
 * no meio.
 */
const VAZIOS = new Set(["null", "undefined", "nil", "none", "n/a", "-"]);

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim() && !VAZIOS.has(v.trim().toLowerCase())) return v.trim();
  if (typeof v === "number") return String(v);
  return undefined;
}

/*
 * Valores chegam como inteiro na menor unidade da moeda — 10000 é R$ 100,00.
 * Ainda assim tratamos string e decimal: gateways mudam formato sem avisar, e
 * confundir centavos com reais erra o faturamento por cem vezes.
 */
function cents(v: unknown): Cents {
  if (typeof v === "number") return Number.isInteger(v) ? v : Math.round(v * 100);
  if (typeof v === "string") {
    const t = v.trim();
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    const n = parseFloat(t.replace(/\./g, "").replace(",", "."));
    return Number.isNaN(n) ? 0 : Math.round(n * 100);
  }
  return 0;
}

function parseItems(data: unknown): OrderItem[] {
  const raw = pick(data, "products") ?? pick(data, "items");
  if (!Array.isArray(raw)) return [];
  return raw.map((p): OrderItem => ({
    sku: str(pick(p, "external_id")) ?? str(pick(p, "sku")) ?? str(pick(p, "id")),
    name: str(pick(p, "name")) ?? "produto",
    quantity: Number(pick(p, "quantity") ?? 1) || 1,
    unitPriceCents: cents(pick(p, "unit_price") ?? pick(p, "price")),
    variant: str(pick(p, "variant")),
    category: str(pick(p, "category")),
  }));
}

/*
 * Campos de repasse. `src` e `sck` são a convenção de afiliado dos gateways
 * brasileiros e é por eles que nosso clickId viaja. `informations` é o campo
 * livre do pagou.ai, ecoado tal como enviado na criação da transação.
 */
const PASSTHROUGH = ["src", "sck", "xcod", "informations", "metadata"] as const;

function parsePassthrough(data: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const attribution = pick(data, "attribution");

  for (const f of PASSTHROUGH) {
    const v = str(pick(data, f)) ?? str(pick(attribution, f));
    if (v) out[f] = v;
  }

  /* `informations` pode vir como objeto; achatamos para busca do clickId. */
  const info = pick(data, "informations");
  if (info && typeof info === "object" && !Array.isArray(info)) {
    for (const [k, v] of Object.entries(info as Record<string, unknown>)) {
      const s = str(v);
      if (s) out[`informations.${k}`] = s;
    }
  }
  return out;
}

export const pagouAdapter: GatewayAdapter = {
  id: "pagou",
  label: "Pagou.ai",
  especie: "gateway",
  /* Tabela publicada; a conta negociada pode ser outra. Ver types.ts. */
  taxasPadrao: {
    pix: { percentual: 7.99, fixoCents: 249 },
    credit_card: [
      { ateParcelas: 1, percentual: 6.99, fixoCents: 599, reservaPercentual: 25 },
      { ateParcelas: 2, percentual: 11.89, fixoCents: 599, reservaPercentual: 25 },
      { ateParcelas: 3, percentual: 13.29, fixoCents: 599, reservaPercentual: 25 },
      { ateParcelas: 4, percentual: 14.74, fixoCents: 599, reservaPercentual: 25 },
      { ateParcelas: 5, percentual: 15.97, fixoCents: 599, reservaPercentual: 25 },
      { ateParcelas: 6, percentual: 16.65, fixoCents: 599, reservaPercentual: 25 },
      { ateParcelas: 7, percentual: 16.99, fixoCents: 599, reservaPercentual: 25 },
      { ateParcelas: 8, percentual: 17.01, fixoCents: 599, reservaPercentual: 25 },
      { ateParcelas: 9, percentual: 17.99, fixoCents: 599, reservaPercentual: 25 },
      { ateParcelas: 10, percentual: 18.01, fixoCents: 599, reservaPercentual: 25 },
      { ateParcelas: 11, percentual: 18.99, fixoCents: 599, reservaPercentual: 25 },
      { ateParcelas: 12, percentual: 23.99, fixoCents: 599, reservaPercentual: 25 },
    ],
  },
  /*
   * Opcional de proposito: sem a chave as vendas continuam entrando, so que
   * marcadas como nao verificadas — a pagou.ai nao assina o webhook, entao a
   * confirmacao depende desta consulta.
   */
  credenciais: [
    { chave: "apiKey", rotulo: "Chave de API",
      dica: "Confirma a venda na origem. Sem ela, a venda entra marcada como não verificada." },
  ],
  passthroughFields: PASSTHROUGH,

  async verify(_req: WebhookRequest, _secret: string): Promise<VerifyResult> {
    /*
     * A documentação do pagou.ai não define assinatura de webhook. Recusar
     * aqui é deliberado: o roteador trata `sem_assinatura` deixando a venda
     * marcada como não verificada, em vez de fingir que está provada. Se um
     * dia publicarem HMAC, a verificação entra aqui e o resto não muda.
     */
    return { ok: false, reason: "sem_assinatura" };
  },

  async parse(req: WebhookRequest): Promise<CanonicalOrder | null> {
    const body = JSON.parse(req.rawBody) as Record<string, unknown>;
    const data = (body.data ?? body) as Record<string, unknown>;

    /* "transaction.paid" ou o status dentro de data. */
    const eventName = str(body.event) ?? "";
    const statusRaw =
      (eventName.includes(".") ? eventName.split(".")[1] : undefined)
      ?? str(data.status)
      ?? "";

    const status = STATUS_MAP[statusRaw.toLowerCase()];
    /* Evento que não representa estado de venda (teste, assinatura, payout). */
    if (!status) return null;

    const gatewayOrderId = str(data.id) ?? str(data.transaction_id) ?? str(body.id);
    if (!gatewayOrderId) return null;

    const attribution = pick(data, "attribution");
    const customerRaw = pick(data, "customer");

    const items = parseItems(data);
    /*
     * `paid_amount` é o que o comprador pagou; `amount` é menor e não bate com
     * o extrato. Numa venda de R$ 5,00 o payload traz paid_amount "500" e
     * amount 475 — usar `amount` fazia o painel registrar R$ 4,75 de
     * faturamento numa venda de cinco reais.
     *
     * Vem como string em `paid_amount` e como número em `amount`; `cents`
     * trata os dois.
     */
    const gross = cents(data.paid_amount ?? data.amount ?? data.total ?? 0)
      || items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0);

    /*
     * A taxa vem num objeto, não num número:
     *
     *   fee: { net_amount, estimated_fee, spread_percentage }
     *
     * `net_amount` é o que a pagou credita. A taxa real é tudo que o comprador
     * pagou menos isso — e não `estimated_fee`, que é calculado sobre `amount`
     * e deixa de fora a diferença entre os dois valores. Na venda de R$ 5,00:
     * 500 − 188 = 312, que é exatamente o que o painel da pagou mostra.
     *
     * Ler o objeto como número devolvia zero, e zero informado pelo gateway
     * vence a tabela de taxas — então a tabela nem chegava a ser consultada.
     */
    const taxa = (() => {
      const f = data.fee;
      if (typeof f === "number" || typeof f === "string") return cents(f);
      if (!f || typeof f !== "object") return undefined;

      const liquido = pick(f, "net_amount");
      if (liquido !== undefined && liquido !== null) {
        const restante = gross - cents(liquido);
        return restante >= 0 ? restante : undefined;
      }

      const estimada = pick(f, "estimated_fee");
      return estimada === undefined || estimada === null ? undefined : cents(estimada);
    })();

    const occurredAt = (() => {
      const t = str(data.paid_at) ?? str(data.created_at) ?? str(body.created_at);
      const d = t ? new Date(t) : new Date();
      return Number.isNaN(d.getTime()) ? new Date() : d;
    })();

    return {
      gatewayOrderId,
      /*
       * A doc manda deduplicar pelo `id` do topo do envelope, que muda a cada
       * entrega. Quando não vier, sintetizamos por pedido+status: reentrega do
       * mesmo estado é ignorada, mudança de estado passa.
       */
      gatewayEventId: str(body.id) ?? `${gatewayOrderId}:${status}`,
      status,
      currency: (str(data.currency) ?? "BRL").toUpperCase(),
      grossCents: gross,
      feeCents: taxa,
      shippingCents: data.shipping !== undefined ? cents(data.shipping) : undefined,
      discountCents: data.discount !== undefined ? cents(data.discount) : undefined,
      /*
       * O campo é `method`, não `payment_method`. Lendo o nome errado, toda
       * venda caía em "other" — e "other" não tem regra na tabela de taxas,
       * então nem a estimativa entrava.
       */
      paymentMethod: METHOD_MAP[
        (str(data.method) ?? str(data.payment_method) ?? "").toLowerCase()
      ] ?? "other",
      installments: data.installments ? Number(data.installments) : undefined,
      items,
      customer: customerRaw ? {
        name: str(pick(customerRaw, "name")),
        email: str(pick(customerRaw, "email")),
        phone: str(pick(customerRaw, "phone")),
        /* Documentado: o CPF nunca é enviado no webhook. */
      } : undefined,
      attribution: attribution ? {
        utmSource: str(pick(attribution, "utm_source")),
        utmMedium: str(pick(attribution, "utm_medium")),
        utmCampaign: str(pick(attribution, "utm_campaign")),
        utmContent: str(pick(attribution, "utm_content")),
        utmTerm: str(pick(attribution, "utm_term")),
        fbc: str(pick(attribution, "fbc")),
        fbp: str(pick(attribution, "fbp")),
        gclid: str(pick(attribution, "gclid")),
        ttclid: str(pick(attribution, "ttclid")),
        landingUrl: str(pick(attribution, "checkout_url")),
        referrer: str(pick(attribution, "referrer_url")),
      } : undefined,
      passthrough: parsePassthrough(data),
      occurredAt,
      raw: body,
    };
  },

  /*
   * Consulta a transação na origem.
   *
   * É o que transforma "chegou uma mensagem dizendo que houve uma venda" em
   * "houve uma venda". Sem assinatura, a mensagem sozinha não prova nada — e
   * uma venda forjada não custa nada a quem descobrir a URL, enquanto custa
   * caro a você: o painel mente e a Meta otimiza para uma conversão que não
   * existiu.
   */
  async fetchOrder(orderId: string, cred: GatewayCredentials): Promise<CanonicalOrder | null> {
    const chave = cred.apiKey ?? cred.secretKey;
    if (!chave) return null;

    const res = await fetch(`https://api.pagou.ai/v2/transactions/${orderId}`, {
      headers: { authorization: `Bearer ${chave}`, accept: "application/json" },
    });

    /* 404 é resposta, não falha: a transação não existe, então a venda é falsa. */
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`pagou.ai respondeu ${res.status} ao confirmar`);

    const j = await res.json() as Record<string, unknown>;
    const data = (j.data ?? j) as Record<string, unknown>;

    const statusRaw = (str(data.status) ?? "").toLowerCase();
    const status = STATUS_MAP[statusRaw];
    if (!status) return null;

    const items = parseItems(data);
    const customerRaw = pick(data, "customer");

    return {
      gatewayOrderId: str(data.id) ?? orderId,
      gatewayEventId: `api:${orderId}:${status}`,
      status,
      currency: (str(data.currency) ?? "BRL").toUpperCase(),
      /* Mesmos nomes do webhook: `paid_amount` é o que o comprador pagou, e o
         campo do método é `method`. Ver os comentários em `parse`. */
      grossCents: cents(data.paid_amount ?? data.amount ?? data.total ?? 0),
      paymentMethod: METHOD_MAP[
        (str(data.method) ?? str(data.payment_method) ?? "").toLowerCase()
      ] ?? "other",
      items,
      customer: customerRaw ? {
        name: str(pick(customerRaw, "name")),
        email: str(pick(customerRaw, "email")),
        phone: str(pick(customerRaw, "phone")),
      } : undefined,
      passthrough: parsePassthrough(data),
      occurredAt: new Date(),
      raw: j,
    };
  },

  /*
   * Busca o comprador completo, que o webhook não traz.
   *
   * O webhook manda `customer` com nome, e-mail e telefone, e nada mais. Por
   * muito tempo isso passou por limitação da pagou.ai — o comentário no topo
   * deste arquivo dizia que o CPF "entra e não sai". Estava errado: o dado
   * existe, num recurso que ninguém tinha chamado.
   *
   *   GET /v2/transactions/{id}   →  buyer.id
   *   GET /v2/customers/{buyer.id}  →  endereço, documento, nascimento
   *
   * São duas chamadas, e só acontecem quando há credencial cadastrada. O custo
   * é alto para o que se ganha: CEP, cidade, estado e país são quatro chaves
   * de correspondência, e o CPF vira `external_id`, que é das mais fortes. Um
   * Purchase sai de três chaves para oito ou nove.
   *
   * NUNCA SOBRESCREVE o que o webhook já disse. O que veio no evento é o que o
   * gateway afirmou sobre AQUELA transação; o cadastro do comprador é o estado
   * atual dele, e pode ter mudado de endereço depois da compra.
   *
   * Falhar aqui não derruba a venda — ela entra com menos chaves, que é melhor
   * que não entrar.
   */
  async enrich(order: CanonicalOrder, cred: GatewayCredentials): Promise<CanonicalOrder> {
    const chave = cred.apiKey ?? cred.secretKey;
    if (!chave) return order;

    const cabecalhos = { authorization: `Bearer ${chave}`, accept: "application/json" };

    const buscar = async (caminho: string): Promise<Record<string, unknown> | null> => {
      const res = await fetch(`https://api.pagou.ai${caminho}`, { headers: cabecalhos });
      if (!res.ok) return null;
      const j = await res.json() as Record<string, unknown>;
      return (j.data ?? j) as Record<string, unknown>;
    };

    try {
      const trx = await buscar(`/v2/transactions/${order.gatewayOrderId}`);
      const idComprador = str(pick(trx, "buyer.id"));
      if (!idComprador) return order;

      const c = await buscar(`/v2/customers/${idComprador}`);
      if (!c) return order;

      const atual = order.customer ?? {};

      /* Data de nascimento serve à Meta como AAAA-MM-DD; corta hora se vier. */
      const nascimento = str(pick(c, "birth_date"))?.slice(0, 10);

      return {
        ...order,
        customer: {
          ...atual,
          name: atual.name ?? str(pick(c, "name")),
          email: atual.email ?? str(pick(c, "email")),
          phone: atual.phone ?? str(pick(c, "phone")),
          document: atual.document ?? str(pick(c, "document.document_number")),
          zip: atual.zip ?? str(pick(c, "address.zip_code")),
          city: atual.city ?? str(pick(c, "address.city")),
          state: atual.state ?? str(pick(c, "address.state")),
          country: atual.country ?? str(pick(c, "address.country")),
          birthdate: atual.birthdate ?? nascimento,
        },
      };
    } catch {
      /* API instável ou credencial sem escopo: segue com o que o webhook deu. */
      return order;
    }
  },
};
