/*
 * Adaptador da Appmax.
 *
 * O gateway mais generoso em dado pessoal que apareceu até agora: o webhook
 * traz `document_number` (CPF), `postcode`, `city` e `state`. Isso destrava as
 * chaves `ct`, `st` e `zp` no CAPI, que o pagou.ai não entrega — e mais três
 * chaves de correspondência é diferença real no EMQ.
 *
 * Também manda `firstname` e `lastname` separados, então não precisamos
 * adivinhar onde termina o nome e começa o sobrenome.
 *
 * Como no pagou.ai, não há assinatura: a documentação diz textualmente que a
 * Appmax não envia header de assinatura nem token nos webhooks. O segredo no
 * caminho da URL é toda a barreira que existe.
 */

import type { GatewayAdapter, WebhookRequest, VerifyResult } from "./types";
import type {
  CanonicalOrder, OrderStatus, PaymentMethod, OrderItem, Cents,
} from "../core/types";

/*
 * A Appmax expõe 29 eventos. Aqui estão os que representam estado de venda;
 * os de cliente e assinatura são ignorados devolvendo `null`.
 */
const STATUS_MAP: Record<string, OrderStatus> = {
  order_authorized: "pending",
  order_authorized_with_delay: "pending",
  payment_authorized_with_delay: "pending",
  order_pending_integration: "pending",
  order_billet_created: "pending",
  order_pix_created: "pending",

  order_approved: "paid",
  order_paid: "paid",
  order_paid_by_pix: "paid",
  order_integrated: "paid",

  order_refused_by_risk: "refused",
  payment_not_authorized: "refused",

  order_billet_overdue: "canceled",
  order_pix_expired: "canceled",

  order_refund: "refunded",
  order_partial_refund: "refunded",

  order_chargeback_in_treatment: "chargeback",
};

/*
 * `order_charge_back_gain` — o lojista ganhou a disputa e o dinheiro volta.
 *
 * Nosso modelo de estado só avança, então não há como sair de `chargeback` de
 * volta para `paid` sem reabrir uma porta que existe justamente para impedir
 * que um webhook atrasado derrube o faturamento do dia. Por ora o evento é
 * ignorado e a venda permanece como contestada; corrigir isso exige um campo
 * de recuperação separado, e não uma exceção na regra de avanço.
 */
const IGNORADOS = new Set(["order_charge_back_gain"]);

const METHOD_MAP: Record<string, PaymentMethod> = {
  creditcard: "credit_card",
  credit_card: "credit_card",
  cartao: "credit_card",
  debitcard: "debit_card",
  boleto: "boleto",
  billet: "boleto",
  pix: "pix",
};

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

/* Valores em centavos: 25990 é R$ 259,90. */
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

/*
 * Os itens podem vir soltos em `products` ou agrupados em `bundles`, conforme
 * a venda tenha ou não combo. Achatamos os dois casos.
 */
function parseItems(order: unknown): OrderItem[] {
  const direto = pick(order, "products");
  const bundles = pick(order, "bundles");

  const brutos: unknown[] = [];
  if (Array.isArray(direto)) brutos.push(...direto);
  if (Array.isArray(bundles)) {
    for (const b of bundles) {
      const ps = pick(b, "products");
      if (Array.isArray(ps)) brutos.push(...ps);
    }
  }

  return brutos.map((p): OrderItem => ({
    sku: str(pick(p, "sku")) ?? str(pick(p, "external_id")) ?? str(pick(p, "id")),
    name: str(pick(p, "name")) ?? str(pick(p, "description")) ?? "produto",
    quantity: Number(pick(p, "quantity") ?? 1) || 1,
    unitPriceCents: cents(pick(p, "price") ?? pick(p, "unit_price") ?? 0),
    variant: str(pick(p, "variant")),
    category: str(pick(p, "category")),
  }));
}

const PASSTHROUGH = ["src", "sck", "xcod", "tracking", "metadata"] as const;

/*
 * A Appmax fica atrás do checkout da própria loja, então o clickId chega até
 * ela pelo objeto `tracking` que a loja preenche ao criar o pedido. Olhamos
 * tanto ali quanto na raiz, porque cada integração preenche num lugar.
 */
function parsePassthrough(order: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const tracking = pick(order, "tracking");

  for (const f of PASSTHROUGH) {
    const v = str(pick(order, f)) ?? str(pick(tracking, f));
    if (v) out[f] = v;
  }

  if (tracking && typeof tracking === "object" && !Array.isArray(tracking)) {
    for (const [k, v] of Object.entries(tracking as Record<string, unknown>)) {
      const s = str(v);
      if (s) out[`tracking.${k}`] = s;
    }
  }
  return out;
}

export const appmaxAdapter: GatewayAdapter = {
  id: "appmax",
  label: "Appmax",
  passthroughFields: PASSTHROUGH,

  async verify(_req: WebhookRequest, _secret: string): Promise<VerifyResult> {
    /* Documentado pela própria Appmax: não há header de assinatura nem token. */
    return { ok: false, reason: "sem_assinatura" };
  },

  async parse(req: WebhookRequest): Promise<CanonicalOrder | null> {
    const body = JSON.parse(req.rawBody) as Record<string, unknown>;

    const evento = (str(body.event) ?? "").toLowerCase();
    if (IGNORADOS.has(evento)) return null;

    const status = STATUS_MAP[evento];
    if (!status) return null;

    const data = (body.data ?? {}) as Record<string, unknown>;
    /* O pedido pode vir em data.order ou direto em data, conforme o evento. */
    const order = (pick(data, "order") ?? data) as Record<string, unknown>;

    const gatewayOrderId = str(order.id) ?? str(data.id);
    if (!gatewayOrderId) return null;

    const customer = pick(data, "customer") ?? pick(order, "customer");
    const amounts = pick(order, "amounts");
    const items = parseItems(order);

    const gross =
      cents(order.total_paid ?? order.total ?? pick(amounts, "sub_total") ?? 0)
      || items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0);

    const pagamento = pick(data, "payment") ?? pick(order, "payment");
    const metodo = str(pick(pagamento, "method")) ?? str(order.payment_type) ?? "";

    const occurredAt = (() => {
      const t = str(pick(pagamento, "paid_at")) ?? str(order.paid_at)
        ?? str(order.updated_at) ?? str(order.created_at);
      const d = t ? new Date(t.replace(" ", "T")) : new Date();
      return Number.isNaN(d.getTime()) ? new Date() : d;
    })();

    /* Nome vem partido; quando não vier, cai no campo único. */
    const first = str(pick(customer, "firstname"));
    const last = str(pick(customer, "lastname"));
    const nomeCompleto = [first, last].filter(Boolean).join(" ")
      || str(pick(customer, "name"));

    return {
      gatewayOrderId,
      /*
       * A Appmax não manda id de entrega. Sintetizamos por pedido+evento: a
       * reentrega do mesmo evento colide e é descartada, e uma mudança de
       * estado passa por ser um evento diferente.
       */
      gatewayEventId: str(body.id) ?? `${gatewayOrderId}:${evento}`,
      status,
      currency: "BRL",
      grossCents: gross,
      shippingCents: amounts ? cents(pick(amounts, "shipping_value")) : undefined,
      discountCents: amounts ? cents(pick(amounts, "discount")) : undefined,
      paymentMethod: METHOD_MAP[metodo.toLowerCase()] ?? "other",
      installments: pick(pagamento, "installments")
        ? Number(pick(pagamento, "installments")) : undefined,
      items,
      customer: customer ? {
        name: nomeCompleto,
        email: str(pick(customer, "email")),
        phone: str(pick(customer, "telephone")) ?? str(pick(customer, "phone")),
        /* CPF: só a Appmax manda. Vira external_id extra no CAPI. */
        document: str(pick(customer, "document_number")),
        zip: str(pick(customer, "postcode")),
        city: str(pick(customer, "city")),
        state: str(pick(customer, "state")),
        country: "br",
      } : undefined,
      passthrough: parsePassthrough(order),
      occurredAt,
      raw: body,
    };
  },
};
