/*
 * Adaptador do pagou.ai.
 *
 * Serve de referência para os demais: mostra o que um adaptador precisa
 * resolver — envelope, dedupe, status, centavos, atribuição e repasse.
 *
 * Duas particularidades deste gateway, ambas documentadas por eles:
 *
 * 1. Não há assinatura HMAC. `verify` devolve `sem_assinatura`, e o roteador
 *    então exige o segredo no path e confirma o valor pela API antes de
 *    contabilizar a venda ou disparar conversão.
 *
 * 2. O CPF do comprador nunca vem no webhook. Isso custa as chaves `ct`, `st`
 *    e `zp` no CAPI — não há como contornar pelo webhook; só consultando a
 *    transação pela API, quando a conta tiver permissão.
 *
 * Em compensação, o bloco `data.attribution` já traz utm_*, fbc, fbp, gclid,
 * ttclid, src e sck. É o gateway mais generoso em atribuição que apareceu até
 * agora, e serve de fonte secundária quando o clickId não resolve.
 */

import type { GatewayAdapter, WebhookRequest, VerifyResult } from "./types";
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

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v.trim();
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
  passthroughFields: PASSTHROUGH,

  async verify(_req: WebhookRequest, _secret: string): Promise<VerifyResult> {
    /*
     * A documentação do pagou.ai não define assinatura de webhook. Recusar
     * aqui é deliberado: o roteador trata `sem_assinatura` exigindo o segredo
     * no path e confirmando o valor pela API antes de contabilizar. Se um dia
     * publicarem HMAC, a verificação entra aqui e o resto do sistema não muda.
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
    const gross = cents(data.amount ?? data.total ?? 0)
      || items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0);

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
      feeCents: data.fee !== undefined ? cents(data.fee) : undefined,
      shippingCents: data.shipping !== undefined ? cents(data.shipping) : undefined,
      discountCents: data.discount !== undefined ? cents(data.discount) : undefined,
      paymentMethod: METHOD_MAP[(str(data.payment_method) ?? "").toLowerCase()] ?? "other",
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
};
