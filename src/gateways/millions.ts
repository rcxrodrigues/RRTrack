/*
 * Adaptador da MillionsPay.
 *
 * O primeiro gateway com assinatura de verdade. Manda HMAC-SHA256 no header
 * `X-SoarLabz-Signature`, no formato `sha256=<hex>` — então aqui a verificação
 * é real e o roteador não precisa cair na regra de "sem assinatura". Uma venda
 * forjada não passa nem sabendo a URL.
 *
 * Também tem `metadata` livre, que é o lugar certo para o clickId: não disputa
 * espaço com campo de afiliado e a Millions devolve o objeto intacto.
 *
 * Traz `tax_id` (CPF/CNPJ) mas não traz endereço, então rende menos chaves de
 * correspondência que a Appmax — o CPF vira external_id adicional, e as chaves
 * de cidade, estado e CEP ficam de fora.
 */

import type {
  GatewayAdapter, WebhookRequest, VerifyResult, GatewayCredentials,
} from "./types";
import type {
  CanonicalOrder, OrderStatus, PaymentMethod, OrderItem, Cents,
} from "../core/types";

const STATUS_MAP: Record<string, OrderStatus> = {
  "charge.pending": "pending",
  "charge.authorized": "pending",
  "charge.captured": "paid",
  "charge.failed": "refused",
  "charge.voided": "canceled",
  "charge.expired": "canceled",
  "charge.partially_refunded": "refunded",
  "charge.refunded": "refunded",
  "charge.chargeback": "chargeback",
};

const METHOD_MAP: Record<string, PaymentMethod> = {
  credit_card: "credit_card",
  debit_card: "debit_card",
  pix: "pix",
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

function cents(v: unknown): Cents {
  if (typeof v === "number") return Number.isInteger(v) ? v : Math.round(v * 100);
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return 0;
}

function parseItems(charge: unknown): OrderItem[] {
  const raw = pick(charge, "items") ?? pick(charge, "products");
  if (!Array.isArray(raw)) return [];
  return raw.map((p): OrderItem => ({
    sku: str(pick(p, "sku")) ?? str(pick(p, "external_id")) ?? str(pick(p, "id")),
    name: str(pick(p, "name")) ?? str(pick(p, "title")) ?? "produto",
    quantity: Number(pick(p, "quantity") ?? 1) || 1,
    unitPriceCents: cents(pick(p, "unit_amount") ?? pick(p, "amount") ?? pick(p, "price")),
  }));
}

const PASSTHROUGH = ["metadata", "external_id", "src", "sck"] as const;

function parsePassthrough(charge: unknown): Record<string, string> {
  const out: Record<string, string> = {};

  const ext = str(pick(charge, "external_id"));
  if (ext) out.external_id = ext;

  const meta = pick(charge, "metadata");
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
      const s = str(v);
      if (s) out[`metadata.${k}`] = s;
    }
  }
  return out;
}

const enc = new TextEncoder();

export const millionsAdapter: GatewayAdapter = {
  id: "millions",
  label: "MillionsPay",
  especie: "gateway",
  /* Tabela publicada; a conta negociada pode ser outra. Ver types.ts. */
  taxasPadrao: {
    pix: { percentual: 2.99, fixoCents: 310, reservaPercentual: 10 },
    boleto: { percentual: 2.99, fixoCents: 345 },
    credit_card: [
      { ateParcelas: 1, percentual: 6.92, fixoCents: 499 },
      { ateParcelas: 2, percentual: 8.98, fixoCents: 499 },
      { ateParcelas: 3, percentual: 10.19, fixoCents: 499 },
      { ateParcelas: 4, percentual: 11.49, fixoCents: 499 },
      { ateParcelas: 5, percentual: 12.79, fixoCents: 499 },
      { ateParcelas: 6, percentual: 14.09, fixoCents: 499 },
      { ateParcelas: 7, percentual: 15.39, fixoCents: 499 },
      { ateParcelas: 8, percentual: 16.69, fixoCents: 499 },
      { ateParcelas: 9, percentual: 18.19, fixoCents: 499 },
      { ateParcelas: 10, percentual: 20.53, fixoCents: 499 },
      { ateParcelas: 11, percentual: 22.1, fixoCents: 499 },
      { ateParcelas: 12, percentual: 23.6, fixoCents: 499 },
    ],
  },
  credenciais: [
    { chave: "signingSecret", rotulo: "Segredo de assinatura",
      dica: "Opcional. A MillionsPay mostra ao CRIAR o endpoint, uma vez só. Em branco a venda entra igual, sem verificação de origem." },
  ],
  passthroughFields: PASSTHROUGH,

  /*
   * Verificação real. Três detalhes que costumam ser feitos errado:
   *
   *   - o HMAC é sobre o corpo cru, byte a byte. Serializar de novo a partir
   *     do JSON já interpretado muda espaços e ordem de chaves, e a assinatura
   *     nunca bate.
   *   - a comparação precisa ser em tempo constante. `a === b` vaza, pelo
   *     tempo de resposta, quantos caracteres iniciais estavam certos, o que
   *     permite descobrir a assinatura byte a byte. `crypto.subtle.verify`
   *     compara em tempo constante.
   *   - o header vem prefixado com "sha256=", que precisa sair antes.
   */
  async verify(
    req: WebhookRequest,
    _secret: string,
    credentials?: GatewayCredentials,
  ): Promise<VerifyResult> {
    /*
     * A chave do HMAC é o segredo que a MillionsPay gera ao criar o endpoint,
     * NÃO o segredo do caminho da nossa URL. São dois valores sem relação: o
     * nosso diz quem pode bater na porta, o dela prova que quem bateu foi ela.
     *
     * Usar o nosso aqui rejeitaria todo webhook verdadeiro com 401 — e o
     * sintoma seria venda que simplesmente não chega, sem erro no painel.
     */
    const chave = credentials?.signingSecret;

    /*
     * Sem o segredo cadastrado, degrada para o mesmo caminho dos gateways que
     * não assinam: o segredo da URL continua valendo como barreira, e a venda
     * entra marcada como não verificada. Recusar seria pior — bloquearia a
     * operação inteira de quem ainda não cadastrou.
     */
    if (!chave) return { ok: false, reason: "sem_assinatura" };

    const header = req.headers["x-soarlabz-signature"]
      ?? req.headers["X-SoarLabz-Signature"];

    if (!header) return { ok: false, reason: "assinatura ausente" };

    const hex = header.startsWith("sha256=") ? header.slice(7) : header;
    if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
      return { ok: false, reason: "assinatura malformada" };
    }

    const assinatura = Uint8Array.from(
      hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)),
    );

    try {
      const key = await crypto.subtle.importKey(
        "raw", enc.encode(chave),
        { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
      );
      const ok = await crypto.subtle.verify("HMAC", key, assinatura, enc.encode(req.rawBody));
      return ok ? { ok: true } : { ok: false, reason: "assinatura inválida" };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "falha ao verificar" };
    }
  },

  async parse(req: WebhookRequest): Promise<CanonicalOrder | null> {
    const body = JSON.parse(req.rawBody) as Record<string, unknown>;

    const evento = (str(body.event) ?? "").toLowerCase();
    const status = STATUS_MAP[evento];
    /* Eventos de submerchant, saque e infração não são venda. */
    if (!status) return null;

    const charge = (body.charge ?? body.data) as Record<string, unknown> | undefined;
    if (!charge) return null;

    const gatewayOrderId = str(charge.id);
    if (!gatewayOrderId) return null;

    const customer = pick(charge, "customer");
    const items = parseItems(charge);

    const gross = cents(charge.total_amount ?? charge.amount ?? 0)
      || items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0);

    const occurredAt = (() => {
      const t = str(charge.captured_at) ?? str(body.occurred_at)
        ?? str(charge.updated_at) ?? str(charge.created_at);
      const d = t ? new Date(t) : new Date();
      return Number.isNaN(d.getTime()) ? new Date() : d;
    })();

    return {
      gatewayOrderId,
      /* A Millions manda id no topo do envelope, um por entrega. */
      gatewayEventId: str(body.id) ?? `${gatewayOrderId}:${evento}`,
      status,
      currency: (str(charge.currency) ?? "BRL").toUpperCase(),
      grossCents: gross,
      shippingCents: charge.shipping_amount !== undefined
        ? cents(charge.shipping_amount) : undefined,
      paymentMethod: METHOD_MAP[(str(charge.payment_method) ?? "").toLowerCase()] ?? "other",
      installments: charge.installments ? Number(charge.installments) : undefined,
      items,
      customer: customer ? {
        name: str(pick(customer, "name")),
        email: str(pick(customer, "email")),
        phone: str(pick(customer, "phone")),
        document: str(pick(customer, "tax_id")),
        country: "br",
        /* Endereço não consta no payload documentado. */
      } : undefined,
      passthrough: parsePassthrough(charge),
      occurredAt,
      raw: body,
    };
  },
};
