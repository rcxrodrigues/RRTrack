/*
 * Adaptador da Appmax.
 *
 * Este é o gateway mais trabalhoso dos três, e a razão está no que o webhook
 * NÃO traz.
 *
 * 1. O webhook de pedido não tem comprador. Nenhum. O envelope carrega
 *    `data.order_id`, valores, produtos e pagamento — e só. Os dados da pessoa
 *    viajam em eventos separados (`customer_*`), que não trazem o id do pedido
 *    para amarrar. A saída é consultar `GET /v1/orders/{id}`, que devolve nome,
 *    e-mail e CPF. Telefone e endereço não vêm nem por ali.
 *
 * 2. Não há campo de repasse no pedido. `client_key` e `external_key` são
 *    identificadores da instalação do aplicativo, não campo livre por venda, e
 *    a criação de pedido não aceita nada customizado. O `tracking` que a Appmax
 *    aceita fica no *cliente*, criado numa chamada anterior, e não volta no
 *    webhook de pedido.
 *
 *    Consequência: o clickId não tem como viajar pela Appmax. A junção depende
 *    de a loja registrar o par (pedido, clickId) no momento da criação — ver a
 *    tabela `order_claims` e a rota /api/claim.
 *
 * 3. Não há assinatura. A própria documentação recomenda confirmar o evento
 *    pela API, que é o que o `enrich` acaba fazendo de quebra.
 *
 * O status vem em português no payload (`aprovado`, `estornado`), enquanto o
 * nome do evento vem em inglês (`order_approved`). Mapeamos os dois.
 */

import type {
  GatewayAdapter, WebhookRequest, VerifyResult, GatewayCredentials,
} from "./types";
import type {
  CanonicalOrder, OrderStatus, PaymentMethod, OrderItem, Cents,
} from "../core/types";

const API = "https://api.appmax.com.br";
const AUTH = "https://auth.appmax.com.br/oauth2/token";

/* Nome do evento, em inglês, no topo do envelope. */
const EVENTO_MAP: Record<string, OrderStatus> = {
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

/* Status do pedido, em português, dentro de `data`. */
const STATUS_MAP: Record<string, OrderStatus> = {
  pendente: "pending",
  autorizado: "pending",
  pendente_integracao: "pending",
  pendente_integracao_em_analise: "pending",

  aprovado: "paid",
  integrado: "paid",

  recusado_por_risco: "refused",
  cancelado: "canceled",
  estornado: "refunded",

  chargeback_em_tratativa: "chargeback",
  chargeback_em_disputa: "chargeback",
  chargeback_perdido: "chargeback",
};

/*
 * `chargeback_vencido` significa crédito recuperado — o lojista ganhou. E
 * `order_charge_back_gain` é o evento equivalente. O modelo de estado só
 * avança, então não há como voltar de `chargeback` para `paid` sem reabrir a
 * porta que impede um webhook atrasado de derrubar o faturamento do dia.
 * Ignorados por ora; resolver exige um campo de recuperação separado.
 */
const IGNORADOS = new Set(["order_charge_back_gain", "chargeback_vencido"]);

const METHOD_MAP: Record<string, PaymentMethod> = {
  credit_card: "credit_card",
  creditcard: "credit_card",
  card: "credit_card",
  pix: "pix",
  billet: "boleto",
  boleto: "boleto",
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

function parseItems(data: unknown): OrderItem[] {
  const raw = pick(data, "products");
  if (!Array.isArray(raw)) return [];
  return raw.map((p): OrderItem => ({
    sku: str(pick(p, "sku")),
    name: str(pick(p, "name")) ?? "produto",
    quantity: Number(pick(p, "quantity") ?? 1) || 1,
    /* `price` já é o valor unitário em centavos. */
    unitPriceCents: cents(pick(p, "price") ?? pick(p, "unit_value")),
  }));
}

/*
 * O objeto de pagamento é uma chave por método: payment_info.credit_card,
 * payment_info.pix, payment_info.billet. Achamos qual veio.
 */
function lerPagamento(data: unknown): { metodo: string; parcelas?: number; pagoEm?: string } {
  const info = pick(data, "payment_info");
  if (!info || typeof info !== "object") return { metodo: "" };

  for (const [metodo, valor] of Object.entries(info as Record<string, unknown>)) {
    if (!valor || typeof valor !== "object") continue;
    return {
      metodo,
      parcelas: Number(pick(valor, "installments")) || undefined,
      pagoEm: str(pick(valor, "captured_at")),
    };
  }
  return { metodo: "" };
}

/* Datas vêm como "2025-03-15 14:30:00", sem T nem fuso — é horário de Brasília. */
function parseData(v: string | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v.includes("T") ? v : v.replace(" ", "T") + "-03:00");
  return Number.isNaN(d.getTime()) ? null : d;
}

/*
 * Não existe campo de repasse por venda. Guardamos `external_key` e
 * `client_key` mesmo assim: são identificadores da instalação, não do pedido,
 * mas se algum dia a Appmax permitir defini-los por venda, a junção já olha
 * aqui sem precisar de mudança.
 */
const PASSTHROUGH = ["external_key", "client_key"] as const;

function parsePassthrough(body: unknown, data: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of PASSTHROUGH) {
    const v = str(pick(data, f)) ?? str(pick(body, f));
    if (v) out[f] = v;
  }
  return out;
}

async function obterToken(cred: GatewayCredentials): Promise<string | null> {
  if (!cred.clientId || !cred.clientSecret) return null;

  const res = await fetch(AUTH, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cred.clientId,
      client_secret: cred.clientSecret,
    }),
  });

  if (!res.ok) return null;
  const j = await res.json() as { access_token?: string };
  return j.access_token ?? null;
}

export const appmaxAdapter: GatewayAdapter = {
  id: "appmax",
  label: "Appmax",
  passthroughFields: PASSTHROUGH,

  async verify(_req: WebhookRequest, _secret: string): Promise<VerifyResult> {
    /* Documentado pela própria Appmax: sem header de assinatura nem token. */
    return { ok: false, reason: "sem_assinatura" };
  },

  async parse(req: WebhookRequest): Promise<CanonicalOrder | null> {
    const body = JSON.parse(req.rawBody) as Record<string, unknown>;

    const evento = (str(body.event) ?? "").toLowerCase();
    const data = (body.data ?? {}) as Record<string, unknown>;
    const statusBruto = (str(data.status) ?? "").toLowerCase();

    if (IGNORADOS.has(evento) || IGNORADOS.has(statusBruto)) return null;

    /*
     * O status do payload manda, porque descreve o estado atual do pedido; o
     * nome do evento é só o gatilho. Quando o status não for reconhecido —
     * a Appmax tem estados que não mapeamos — o evento serve de reserva.
     */
    const status = STATUS_MAP[statusBruto] ?? EVENTO_MAP[evento];
    if (!status) return null;

    const gatewayOrderId = str(data.order_id);
    if (!gatewayOrderId) return null;

    const items = parseItems(data);
    const pagamento = lerPagamento(data);

    const gross = cents(data.total) || items.reduce(
      (s, i) => s + i.unitPriceCents * i.quantity, 0,
    );

    const occurredAt =
      parseData(str(data.paid_at))
      ?? parseData(pagamento.pagoEm)
      ?? parseData(str(data.created_at))
      ?? new Date();

    return {
      gatewayOrderId,
      /*
       * A Appmax não manda id de entrega. Sintetizamos por pedido+status: a
       * reentrega do mesmo estado colide e é descartada; mudança de estado
       * passa por ser um valor diferente.
       */
      gatewayEventId: `${gatewayOrderId}:${status}`,
      status,
      currency: "BRL",
      grossCents: gross,
      shippingCents: data.freight_value !== undefined
        ? cents(data.freight_value) : undefined,
      discountCents: data.discount !== undefined ? cents(data.discount) : undefined,
      paymentMethod: METHOD_MAP[pagamento.metodo.toLowerCase()] ?? "other",
      installments: pagamento.parcelas,
      items,
      /* O webhook de pedido não traz comprador. Quem preenche é o enrich. */
      customer: undefined,
      passthrough: parsePassthrough(body, data),
      occurredAt,
      raw: body,
    };
  },

  /*
   * Busca o comprador pela API. Devolve nome, e-mail e CPF — telefone e
   * endereço a Appmax não expõe nesta rota, então as chaves `ph`, `ct`, `st`
   * e `zp` ficam de fora mesmo com a consulta.
   */
  async enrich(order: CanonicalOrder, cred: GatewayCredentials): Promise<CanonicalOrder> {
    try {
      const token = await obterToken(cred);
      if (!token) return order;

      const res = await fetch(`${API}/v1/orders/${order.gatewayOrderId}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
      if (!res.ok) return order;

      const j = await res.json() as Record<string, unknown>;
      const c = pick(j, "data.customer") ?? pick(j, "customer");
      if (!c) return order;

      return {
        ...order,
        customer: {
          name: str(pick(c, "name"))
            ?? ([str(pick(c, "first_name")), str(pick(c, "last_name"))]
              .filter(Boolean).join(" ") || undefined),
          email: str(pick(c, "email")),
          phone: str(pick(c, "phone")) ?? str(pick(c, "telephone")),
          document: str(pick(c, "document_number")),
          country: "br",
        },
      };
    } catch {
      /* Enriquecer é melhor-esforço: a venda entra com menos chaves, não some. */
      return order;
    }
  },
};
