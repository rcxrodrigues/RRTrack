/*
 * O formato canônico do RRTrack.
 *
 * Todo gateway fala um dialeto diferente: a Kiwify chama de `order_status`,
 * a Hotmart de `purchase.status`, o pagou.ai de `event: transaction.paid`.
 * Adaptadores traduzem cada dialeto para os tipos deste arquivo, e o resto
 * do sistema — atribuição, painel, envio para as plataformas de anúncio —
 * só conhece o que está aqui.
 *
 * Regra que não se quebra: nenhum campo específico de um gateway atravessa
 * esta fronteira. Se um gateway manda algo que só ele tem, vai em `raw`.
 */

/** Dinheiro é sempre inteiro, na menor unidade da moeda (centavos em BRL). */
export type Cents = number;

/*
 * Estados que uma venda pode assumir. É deliberadamente menor que a união de
 * todos os gateways: `transaction.three_ds_required` do pagou.ai e
 * `waiting_payment` da Kiwify viram ambos `pending`, porque para faturamento,
 * atribuição e otimização de anúncio a distinção não muda nada.
 *
 * A ordem importa: só se avança na lista. Um webhook de `pending` que chega
 * atrasado, depois do `paid`, é ignorado — gateways não garantem ordem.
 */
export const ORDER_STATUS_RANK = {
  pending: 0,
  refused: 1,
  paid: 2,
  canceled: 3,
  refunded: 4,
  chargeback: 5,
} as const;

export type OrderStatus = keyof typeof ORDER_STATUS_RANK;

/** Só estes contam como faturamento. */
export const REVENUE_STATUSES: readonly OrderStatus[] = ["paid"];

export type PaymentMethod =
  | "pix"
  | "credit_card"
  | "debit_card"
  | "boleto"
  | "wallet"
  | "other";

/*
 * Tudo que o navegador sabe sobre a origem de uma visita.
 *
 * Isto nasce no snippet do site e vive no servidor com uma chave própria
 * (`clickId`). O gateway nunca precisa entender nada disto — ele só devolve
 * o `clickId` no campo de repasse, e o servidor reencontra o resto.
 */
export interface ClickContext {
  /** UUID gerado por nós. A chave de junção entre navegador e webhook. */
  clickId: string;

  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  utmId?: string;

  /* Identificadores de clique das plataformas. */
  fbclid?: string;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  ttclid?: string;
  msclkid?: string;
  twclid?: string;
  epik?: string;
  liFatId?: string;
  kwaiClickId?: string;

  /*
   * Cookies da Meta. Sem GTM e sem o pixel da Meta no navegador, somos nós
   * que geramos e mantemos estes dois — ver core/identity.ts. O `fbc` é a
   * chave de correspondência mais valiosa que existe para tráfego pago.
   */
  fbp?: string;
  fbc?: string;

  /* Rede — exigidos pelo CAPI e pelo Enhanced Conversions do Google. */
  ip?: string;
  userAgent?: string;

  landingUrl?: string;
  referrer?: string;

  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface OrderItem {
  /** SKU do lojista, não o id interno do gateway. */
  sku?: string;
  name: string;
  quantity: number;
  unitPriceCents: Cents;
  /** Custo do produto, quando conhecido. É o que permite calcular lucro real. */
  unitCostCents?: Cents;
  variant?: string;
  category?: string;
}

export interface Customer {
  name?: string;
  email?: string;
  phone?: string;
  /** CPF/CNPJ. Vários gateways nunca enviam — ver o adaptador de cada um. */
  document?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  /* AAAA-MM-DD. Vira a chave `db` da Meta. */
  birthdate?: string;
  /* "m" ou "f". Vira a chave `ge`. */
  gender?: string;
}

/**
 * O que um adaptador de gateway devolve. Uma venda, num formato só.
 */
export interface CanonicalOrder {
  /** Id da venda no gateway. Estável entre webhooks da mesma venda. */
  gatewayOrderId: string;
  /*
   * Id deste webhook específico. Muda a cada entrega; é por ele que se
   * deduplica reentrega. Quando o gateway não fornece um, o adaptador
   * sintetiza a partir de (gatewayOrderId + status).
   */
  gatewayEventId: string;

  status: OrderStatus;
  currency: string;

  /** Valor cheio pago pelo cliente, incluindo frete. */
  grossCents: Cents;
  /** Taxa do gateway, quando informada. */
  feeCents?: Cents;
  shippingCents?: Cents;
  /* Juro do parcelamento cobrado do comprador, quando o gateway informa. */
  interestCents?: Cents;
  discountCents?: Cents;

  paymentMethod: PaymentMethod;
  /** Parcelas, quando cartão. */
  installments?: number;

  items: OrderItem[];
  customer?: Customer;

  /*
   * Atribuição que o próprio gateway carregava. Alguns (pagou.ai) devolvem
   * UTMs e até fbp/fbc; outros não devolvem nada. Serve como fonte secundária
   * quando o `clickId` não resolve.
   */
  attribution?: Partial<ClickContext>;

  /*
   * Campos de repasse do gateway — `src`, `sck`, `xcod`, `informations`,
   * `metadata`. É onde nosso `clickId` viaja de ida e volta.
   */
  passthrough: Record<string, string>;

  occurredAt: Date;

  /** Payload original, para depurar e para reprocessar quando o adaptador mudar. */
  raw: unknown;
}
