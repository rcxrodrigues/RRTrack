/*
 * Entrada por API — a venda empurrada por quem não tem adaptador.
 *
 * Todo gateway novo precisaria de um arquivo aqui, e são dezenas: Kiwify,
 * Hotmart, Braip, Monetizze, Cakto, checkout próprio. Escrever adaptador para
 * cada um é trabalho sem fim, e enquanto o adaptador não existe a loja fica sem
 * rastreamento nenhum — que é o pior desfecho.
 *
 * Este é a saída: o sistema da loja manda a venda já no formato daqui. Vale
 * para gateway sem adaptador, para ERP, para checkout caseiro e para o caso em
 * que a loja simplesmente prefere controlar o que envia.
 *
 * Ele é um adaptador de verdade, registrado como os outros, e não um caminho
 * paralelo. Isso importa: a venda empurrada passa exatamente pelas mesmas
 * regras — atribuição, custo, ordem de estados, disparo, reconciliação — em vez
 * de ganhar um caminho próprio que amanhã divergiria.
 *
 * DINHEIRO, a decisão que evita o erro mais caro: `valor` é sempre na moeda
 * (199.90 = R$ 199,90) e `valor_centavos` é sempre em centavos (19990). Nunca
 * se adivinha pelo formato do número — 19990 sozinho tanto pode ser R$ 199,90
 * quanto R$ 19.990,00, e adivinhar errado manda para a Meta um valor cem vezes
 * maior, que ela usa para otimizar.
 *
 * Aceita os nomes em português e em inglês porque a loja pode estar em qualquer
 * um dos dois, e errar o nome de um campo não dá erro: dá venda sem chave de
 * correspondência, que é uma falha silenciosa.
 */

import type {
  GatewayAdapter, WebhookRequest, VerifyResult,
} from "./types";
import type {
  CanonicalOrder, OrderStatus, PaymentMethod, OrderItem, Customer, Cents,
} from "../core/types";

const STATUS: Record<string, OrderStatus> = {
  /* português */
  pendente: "pending", aguardando: "pending", processando: "pending",
  pago: "paid", aprovado: "paid", pago_parcial: "paid",
  recusado: "refused", negado: "refused",
  cancelado: "canceled",
  estornado: "refunded", reembolsado: "refunded",
  chargeback: "chargeback", contestado: "chargeback",
  /* inglês */
  pending: "pending", waiting: "pending", processing: "pending",
  /* Nome da Utmify. Quem ja integrou com eles aponta para ca sem mexer. */
  waiting_payment: "pending",
  paid: "paid", approved: "paid", completed: "paid",
  refused: "refused", declined: "refused", failed: "refused",
  canceled: "canceled", cancelled: "canceled",
  refunded: "refunded",
  chargedback: "chargeback",
};

const METODO: Record<string, PaymentMethod> = {
  pix: "pix",
  cartao: "credit_card", cartao_credito: "credit_card", credito: "credit_card",
  credit_card: "credit_card", creditcard: "credit_card", card: "credit_card",
  cartao_debito: "debit_card", debito: "debit_card", debit_card: "debit_card",
  boleto: "boleto", bank_slip: "boleto",
  carteira: "wallet", wallet: "wallet", paypal: "wallet",
  /*
   * "free_price" e a venda de valor zero da Utmify — brinde, cortesia, plano
   * gratuito. Nao passa por adquirente nenhuma, entao nao e cartao: cair em
   * credito faria a tabela de taxas descontar uma taxa que ninguem cobrou.
   */
  free_price: "other", gratis: "other", free: "other",
};

/* Campos onde o clickId pode ter viajado, na entrada por API. */
const REPASSE = ["click_id", "clickId", "sck", "src", "xcod", "utm_id", "tracking"] as const;

/*
 * Converte texto em instante, tratando data SEM FUSO como UTC.
 *
 * "2026-08-29 14:30:00" e o formato da Utmify, e a documentacao deles diz que
 * e UTC. O `new Date` do JavaScript le exatamente essa forma como hora LOCAL
 * do servidor — num servidor em Sao Paulo a venda entra tres horas atrasada,
 * o que joga toda venda entre 21h e meia-noite para o dia anterior.
 *
 * O erro nao aparece: a venda entra, com data plausivel, no dia errado. E o
 * faturamento do dia fecha diferente do extrato sem ninguem saber por que.
 *
 * Data COM fuso escrito continua sendo respeitada como veio.
 */
function instante(v: unknown): Date | undefined {
  const t = texto(v);
  if (!t) return undefined;
  const cru = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(t)
    ? t.replace(" ", "T") + "Z"
    : t;
  const d = new Date(cru);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function texto(v: unknown): string | undefined {
  if (typeof v === "string") { const t = v.trim(); return t || undefined; }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? v as Record<string, unknown>
    : undefined;
}

/** Primeiro dos nomes que existir. Aceita português e inglês. */
function campo(fonte: Record<string, unknown>, ...nomes: string[]): unknown {
  for (const n of nomes) if (fonte[n] !== undefined && fonte[n] !== null) return fonte[n];
  return undefined;
}

/*
 * Converte para centavos SEM adivinhar.
 *
 * `emCentavos` decide, e vem de qual campo o valor saiu — não do formato do
 * número. É a diferença entre R$ 199,90 e R$ 19.990,00 num pedido só, e entre
 * um ROAS real e um cem vezes inflado no painel.
 */
function paraCentavos(v: unknown, emCentavos: boolean): Cents {
  if (v === undefined || v === null) return 0;

  if (typeof v === "number") {
    return emCentavos ? Math.round(v) : Math.round(v * 100);
  }

  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return 0;
    if (emCentavos) {
      const n = parseInt(t.replace(/\D/g, ""), 10);
      return Number.isNaN(n) ? 0 : n;
    }
    /*
     * "1.234,56" (BR) e "1234.56" (US) chegam os dois. A vírgula decidindo o
     * decimal é a pista: quando ela existe, o ponto é separador de milhar.
     */
    const normal = t.includes(",")
      ? t.replace(/\./g, "").replace(",", ".")
      : t;
    const n = parseFloat(normal.replace(/[^\d.-]/g, ""));
    return Number.isNaN(n) ? 0 : Math.round(n * 100);
  }

  return 0;
}

/** Lê um par valor/valor_centavos, respeitando qual dos dois veio. */
function dinheiro(
  fonte: Record<string, unknown>,
  nome: string,
  nomeIngles: string,
): Cents | undefined {
  const cent = campo(fonte,
    `${nome}_centavos`, `${nomeIngles}_cents`, `${nomeIngles}Cents`,
    /* `priceInCents`, `totalPriceInCents` — o jeito da Utmify. */
    `${nomeIngles}InCents`);
  if (cent !== undefined) return paraCentavos(cent, true);

  const moeda = campo(fonte, nome, nomeIngles);
  if (moeda !== undefined) return paraCentavos(moeda, false);

  return undefined;
}

function lerItens(fonte: Record<string, unknown>): OrderItem[] {
  const bruto = campo(fonte, "itens", "items", "produtos", "products");
  if (!Array.isArray(bruto)) return [];

  return bruto.map((cru): OrderItem | null => {
    const i = obj(cru);
    if (!i) return null;

    const nome = texto(campo(i, "nome", "name", "titulo", "title"));
    if (!nome) return null;

    const qtd = Number(campo(i, "quantidade", "quantity", "qtd", "qty") ?? 1);

    return {
      sku: texto(campo(i, "sku", "codigo", "code", "id")),
      name: nome,
      quantity: Number.isFinite(qtd) && qtd > 0 ? Math.round(qtd) : 1,
      unitPriceCents: dinheiro(i, "preco", "price")
        ?? dinheiro(i, "valor", "amount") ?? 0,
      unitCostCents: dinheiro(i, "custo", "cost"),
      /* `planName` e o nome do plano na Utmify — e variacao, para nos. */
      variant: texto(campo(i, "variacao", "variant", "variante", "planName", "plan_name")),
      category: texto(campo(i, "categoria", "category")),
    };
  }).filter((i): i is OrderItem => i !== null);
}

function lerCliente(fonte: Record<string, unknown>): Customer | undefined {
  const c = obj(campo(fonte, "cliente", "customer", "comprador", "buyer"));
  if (!c) return undefined;

  const cliente: Customer = {
    name: texto(campo(c, "nome", "name", "nome_completo", "full_name")),
    email: texto(campo(c, "email", "e_mail")),
    phone: texto(campo(c, "telefone", "phone", "celular", "mobile", "whatsapp")),
    document: texto(campo(c, "documento", "document", "cpf", "cnpj", "tax_id")),
    zip: texto(campo(c, "cep", "zip", "zipcode", "postal_code")),
    city: texto(campo(c, "cidade", "city")),
    state: texto(campo(c, "estado", "state", "uf")),
    country: texto(campo(c, "pais", "country")) ?? "br",
    birthdate: texto(campo(c, "nascimento", "birthdate", "data_nascimento", "birth_date")),
    gender: texto(campo(c, "genero", "gender", "sexo")),
  };

  /*
   * Endereço pode vir aninhado, que é como a maioria dos checkouts o guarda.
   * Sem isto se perdem `ct`, `st` e `zp` — três chaves de correspondência — e
   * nada acusaria, porque a venda entra normalmente.
   */
  const end = obj(campo(c, "endereco", "address", "shipping", "entrega"))
    ?? obj(campo(fonte, "endereco", "address", "shipping", "entrega"));

  if (end) {
    cliente.zip ??= texto(campo(end, "cep", "zip", "zipcode", "postal_code"));
    cliente.city ??= texto(campo(end, "cidade", "city"));
    cliente.state ??= texto(campo(end, "estado", "state", "uf"));
    cliente.country ??= texto(campo(end, "pais", "country"));
  }

  return Object.values(cliente).some((v) => v !== undefined && v !== "br")
    ? cliente
    : undefined;
}

function lerRepasse(fonte: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};

  for (const f of REPASSE) {
    const v = texto(fonte[f]);
    if (v) out[f] = v;
  }

  /*
   * E dentro do bloco de rastreamento, que e onde a Utmify guarda `sck`.
   *
   * Olhar so o topo do corpo era o suficiente enquanto o formato fosse nosso.
   * No formato deles, `sck` mora em `trackingParameters` — e `sck` e
   * justamente por onde o nosso clickId volta. Sem esta parte, toda venda
   * vinda de la entrava sem origem: nao dava erro, so nao tinha campanha.
   */
  for (const nome of ["repasse", "passthrough", "metadata", "meta", "custom",
    "trackingParameters", "tracking_parameters", "utm", "utms",
    "atribuicao", "attribution"]) {
    const bloco = obj(fonte[nome]);
    if (!bloco) continue;
    for (const [k, v] of Object.entries(bloco)) {
      const s = texto(v);
      if (s) out[k] = s;
    }
  }

  return out;
}

export const genericoAdapter: GatewayAdapter = {
  id: "api",
  label: "Entrada por API",
  /* Nem plataforma nem gateway: o servidor do lojista falando direto conosco. */
  especie: "api",
  passthroughFields: REPASSE,

  /*
   * A defesa é o segredo no caminho da URL, como em gateway que não assina.
   * Quem manda a venda é o servidor da loja, então não há chave compartilhada
   * a conferir além dessa — e é por isso que o segredo é longo, por conexão, e
   * nunca deve aparecer em código de navegador.
   */
  async verify(): Promise<VerifyResult> {
    return { ok: false, reason: "sem_assinatura" };
  },

  async parse(req: WebhookRequest): Promise<CanonicalOrder | null> {
    const body = JSON.parse(req.rawBody) as Record<string, unknown>;
    /* Aceita tanto o objeto no topo quanto embrulhado em `pedido`/`order`. */
    const d = obj(campo(body, "pedido", "order", "data")) ?? body;

    const pedidoId = texto(campo(d, "pedido_id", "order_id", "orderId", "id", "codigo", "code"));
    if (!pedidoId) return null;

    const statusBruto = (texto(campo(d, "status", "situacao", "state")) ?? "").toLowerCase();
    const status = STATUS[statusBruto];
    /* Estado que não reconhecemos não vira venda: melhor ignorar que inventar. */
    if (!status) return null;

    const itens = lerItens(d);

    /*
     * O bloco financeiro da Utmify. Vem separado do pedido:
     *
     *   commission: { totalPriceInCents, gatewayFeeInCents, currency }
     *
     * Ler so o topo perdia o valor inteiro de quem manda no formato deles — a
     * venda entrava valendo a soma dos itens, sem frete e sem juros.
     */
    const comissao = obj(campo(d, "commission", "comissao"));

    const bruto = dinheiro(d, "valor", "amount")
      ?? dinheiro(d, "total", "total")
      ?? (comissao ? dinheiro(comissao, "total", "totalPrice") : undefined)
      ?? itens.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0);

    /*
     * A ordem importa: o instante da venda e quando ela foi PAGA, e so na
     * falta disso quando foi criada. Um pedido criado ontem e pago hoje conta
     * no faturamento de hoje — e e no dia do pagamento que o gasto do anuncio
     * tem com o que ser comparado.
     */
    const quando = instante(campo(d, "pago_em", "paid_at", "approvedDate", "approved_date"))
      ?? instante(campo(d, "estornado_em", "refundedAt", "refunded_at"))
      ?? instante(campo(d, "criado_em", "created_at", "createdAt", "data", "date"))
      ?? new Date();

    /*
     * `trackingParameters` e onde a Utmify guarda UTM, `src` e `sck` — e `sck`
     * e justamente por onde o nosso clickId volta. Sem ler este bloco, quem
     * manda no formato deles entrega venda sem origem nenhuma.
     */
    const utm = obj(campo(d, "utm", "utms", "atribuicao", "attribution",
      "trackingParameters", "tracking_parameters"));

    /* Fora do bloco de UTM porque a Utmify o guarda dentro de `customer`. */
    const ipDoCliente = texto(campo(
      obj(campo(d, "cliente", "customer", "comprador", "buyer")) ?? {}, "ip",
    ));
    const parcelas = Number(campo(d, "parcelas", "installments") ?? 0);

    return {
      gatewayOrderId: pedidoId,
      /*
       * Sintetizado por pedido+estado. É o que faz o mesmo POST repetido — por
       * retentativa da loja, por dedo duplo — não virar venda duplicada.
       */
      gatewayEventId: texto(campo(d, "evento_id", "event_id")) ?? `${pedidoId}:${status}`,
      status,
      currency: (
        texto(campo(d, "moeda", "currency"))
        ?? (comissao ? texto(campo(comissao, "moeda", "currency")) : undefined)
        ?? "BRL"
      ).toUpperCase(),
      grossCents: bruto,
      feeCents: dinheiro(d, "taxa", "fee")
        ?? (comissao ? dinheiro(comissao, "taxa_gateway", "gatewayFee") : undefined),
      shippingCents: dinheiro(d, "frete", "shipping"),
      discountCents: dinheiro(d, "desconto", "discount"),
      paymentMethod: METODO[
        (texto(campo(d, "metodo", "payment_method", "paymentMethod", "forma_pagamento")) ?? "").toLowerCase()
      ] ?? "other",
      installments: Number.isFinite(parcelas) && parcelas > 0 ? Math.round(parcelas) : undefined,
      items: itens,
      customer: lerCliente(d),
      /*
       * A atribuicao sai do bloco de UTM E do comprador — o IP mora la dentro,
       * no formato da Utmify. Amarrar tudo a existencia do bloco de UTM
       * perdia o IP de quem manda venda sem campanha, que e chave de
       * correspondencia igual as outras.
       */
      attribution: (utm || ipDoCliente) ? {
        utmSource: texto(campo(utm ?? {}, "utm_source", "source", "origem")),
        utmMedium: texto(campo(utm ?? {}, "utm_medium", "medium", "midia")),
        utmCampaign: texto(campo(utm ?? {}, "utm_campaign", "campaign", "campanha")),
        utmContent: texto(campo(utm ?? {}, "utm_content", "content", "conteudo")),
        utmTerm: texto(campo(utm ?? {}, "utm_term", "term", "termo")),
        fbc: texto(campo(utm ?? {}, "fbc", "_fbc")),
        fbp: texto(campo(utm ?? {}, "fbp", "_fbp")),
        gclid: texto(campo(utm ?? {}, "gclid")),
        ttclid: texto(campo(utm ?? {}, "ttclid")),
        /*
         * O IP do comprador, que a Utmify aceita dentro de `customer`.
         *
         * E chave de correspondencia no CAPI da Meta e no Enhanced Conversions
         * do Google, e e das poucas que a venda empurrada por servidor pode
         * trazer — o navegador do comprador nunca falou conosco nesse caminho.
         */
        ip: ipDoCliente,
      } : undefined,
      passthrough: lerRepasse(d),
      occurredAt: quando,
      raw: body,
    };
  },
};

/*
 * O MESMO leitor, servido como webhook de plataforma.
 *
 * Existe porque a lista de integracoes prontas nunca vai estar completa: hoje
 * sao quatro, e a loja pode usar Kiwify, Hotmart, Braip, Cartpanda ou um
 * checkout que ninguem aqui conhece. Sem isto, ligar qualquer uma delas
 * dependia de alguem escrever um adaptador — e ate la a venda simplesmente
 * nao entrava.
 *
 * A diferenca para `genericoAdapter` e so onde a coisa mora: aquele e uma
 * credencial que o servidor da loja usa; este e uma URL que a plataforma
 * chama. Mesmo payload, mesmo tratamento, cartoes diferentes na tela.
 *
 * Nao verifica assinatura porque nao ha como: cada plataforma assina de um
 * jeito, e um leitor generico nao sabe qual. A venda entra marcada como nao
 * verificada, e o segredo da URL e a barreira — o mesmo trato dos gateways
 * que nao assinam. Quando uma delas virar integracao propria, com assinatura
 * de verdade, e so escrever o adaptador.
 */
export const webhookGenericoAdapter: GatewayAdapter = {
  ...genericoAdapter,
  id: "webhook",
  /*
   * O "+" e o verbo estao no rotulo de proposito: no menu, "Outra plataforma"
   * lia como o nome de uma marca que ninguem conhece. O que a pessoa procura
   * ali e a acao — cadastrar a que ela usa e nao esta na lista.
   */
  label: "+ Cadastrar nova plataforma",
  especie: "plataforma",
};

/*
 * O mesmo coringa, do lado dos gateways de pagamento.
 *
 * Sao dois e nao um porque o menu separa plataforma de gateway, e quem
 * procura onde ligar a Kiwify nao olha em "Gateways de pagamento" — nem quem
 * procura onde ligar um adquirente olha em "Plataformas de venda". A unica
 * diferenca entre os dois e o grupo em que aparecem e o texto do rotulo: o
 * leitor, a rota e o tratamento sao os mesmos.
 */
export const gatewayGenericoAdapter: GatewayAdapter = {
  ...genericoAdapter,
  id: "gateway",
  label: "+ Cadastrar novo gateway",
  especie: "gateway",
};
