/*
 * O que acontece quando alguém aperta "pagar".
 *
 * Este arquivo fica entre a página pública e o driver do gateway, e existe por
 * três motivos que não cabem em nenhum dos dois lados.
 *
 * O PREÇO É DECIDIDO AQUI. Nada que chegue do navegador influencia valor: o
 * corpo do POST diz o método e as parcelas, e os itens vêm da linha do
 * checkout no banco. Um checkout que aceita o preço enviado pelo cliente vende
 * de graça na primeira vez que alguém abrir o inspetor — e não existe jeito de
 * descobrir isso pelo painel, porque a venda entra bonitinha, só que por R$ 1.
 *
 * A ATRIBUIÇÃO FECHA AQUI, e é o motivo de o checkout valer mais que a taxa
 * economizada. Em toda venda por gateway de terceiro, o clickId precisa
 * atravessar o domínio do gateway num campo de repasse e voltar no webhook —
 * quando o gateway tem esse campo, o que a Appmax não tem. Com o pagamento no
 * nosso domínio, nós conhecemos o clickId e o id do pedido no mesmo instante,
 * e a reivindicação deixa de depender de terceiro. É a única via em que a
 * atribuição é fato, não inferência.
 *
 * O LIMITE DE TENTATIVAS MORA AQUI. Rota pública que cobra cartão atrai teste
 * de cartão roubado, e quem leva o estorno e o bloqueio da adquirente é o
 * lojista.
 *
 * A venda em si NÃO é gravada aqui. Quem grava é o webhook, como em qualquer
 * outra venda — um caminho de escrita só, com a deduplicação que ele já tem.
 * Gravar dos dois lados criaria duas verdades sobre o mesmo pedido.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../db/index";
import {
  checkoutAttempts, checkoutOrders, checkouts, clickSessions, gatewayConnections,
  orderClaims, orders, sites,
} from "../db/schema";
import { decryptRecord, encryptValue } from "../core/crypto";
import { cobradorDe } from "./cobradores";
import type { DadosPix, PagamentoPedido } from "./tipos";

/* ---------------------------------------------------------------- tipos -- */

export interface CompradorEnviado {
  nome?: string;
  email?: string;
  telefone?: string;
  documento?: string;
  cep?: string;
  rua?: string;
  numero?: string;
  complemento?: string;
  bairro?: string;
  cidade?: string;
  estado?: string;
}

export interface PedidoDoNavegador {
  slug: string;
  /** UUID do rr.js. Sem ele a venda entra, mas sem dono. */
  clickId?: string;
  comprador: CompradorEnviado;
  metodo: "pix" | "credit_card";
  parcelas?: number;
  /** Token do cartão gerado pelo appmax.min.js. Nunca o número. */
  cartao?: { token?: string; titular?: string; documento?: string };
}

export type RespostaCheckout =
  | {
      ok: true;
      gatewayOrderId: string;
      metodo: "pix" | "credit_card";
      pix?: DadosPix;
      /* Para onde mandar o comprador quando a cobrança não é instantânea. */
      redirect?: string;
    }
  | { ok: false; tipo: "recusado" | "erro" | "invalido" | "limite"; motivo: string };

/* ------------------------------------------------------------ validação -- */

const soDigitos = (s: string): string => s.replace(/\D/g, "");

/*
 * CPF de verdade, não só onze dígitos.
 *
 * A Appmax recusa CPF inválido, mas a recusa dela vem depois de criarmos
 * cliente e pedido — três chamadas de rede para descobrir um erro de digitação.
 * Conferir aqui devolve na hora e deixa o comprador corrigir enquanto ainda
 * está olhando o campo.
 */
function cpfValido(bruto: string): boolean {
  const d = soDigitos(bruto);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;

  const digito = (ate: number): number => {
    let soma = 0;
    for (let i = 0; i < ate; i++) soma += Number(d[i]) * (ate + 1 - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };

  return digito(9) === Number(d[9]) && digito(10) === Number(d[10]);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/* ------------------------------------------------------------- limitador -- */

/*
 * Teto de tentativas por IP.
 *
 * Dois tetos, porque os dois abusos têm formatos diferentes. Volume alto em
 * pouco tempo é robô. Já recusa repetida ao longo da hora é a assinatura do
 * teste de cartão: o fraudador não se importa com a recusa, ele está
 * justamente procurando qual número passa.
 *
 * A contagem vive no banco e não em memória porque cada requisição na Vercel
 * pode cair numa instância diferente — um contador em memória só pega quem tem
 * o azar de bater duas vezes no mesmo processo.
 */
const TETO_CURTO = { tentativas: 6, minutos: 15 };
const TETO_RECUSA = { tentativas: 3, minutos: 60 };

async function excedeuLimite(ip: string): Promise<string | null> {
  const desde = (min: number) => new Date(Date.now() - min * 60_000);

  const [curto] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(checkoutAttempts)
    .where(and(
      eq(checkoutAttempts.ip, ip),
      gte(checkoutAttempts.createdAt, desde(TETO_CURTO.minutos)),
    ));

  if ((curto?.n ?? 0) >= TETO_CURTO.tentativas) {
    return "muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.";
  }

  const [recusas] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(checkoutAttempts)
    .where(and(
      eq(checkoutAttempts.ip, ip),
      eq(checkoutAttempts.outcome, "recusado"),
      gte(checkoutAttempts.createdAt, desde(TETO_RECUSA.minutos)),
    ));

  if ((recusas?.n ?? 0) >= TETO_RECUSA.tentativas) {
    return "não foi possível concluir o pagamento. Entre em contato com o suporte.";
  }

  return null;
}

/* ------------------------------------------------------------- checkout -- */

export interface CheckoutPublico {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  items: Array<{ sku: string; name: string; quantity: number; unitPriceCents: number; digital?: boolean }>;
  shippingCents: number;
  methods: string[];
  maxInstallments: number;
  config: Record<string, string>;
  /* Chave pública do site, para a página carregar o rr.js certo. */
  siteKey?: string;
  siteDomain?: string;
}

/** O que a página pública precisa saber. Nunca inclui credencial. */
export async function checkoutPorSlug(slug: string): Promise<CheckoutPublico | null> {
  const [linha] = await db
    .select({
      c: checkouts,
      sitePublicKey: sites.publicKey,
      siteDomain: sites.domain,
    })
    .from(checkouts)
    .leftJoin(sites, eq(sites.id, checkouts.siteId))
    .where(and(eq(checkouts.slug, slug), eq(checkouts.active, true)))
    .limit(1);

  if (!linha) return null;

  return {
    id: linha.c.id,
    tenantId: linha.c.tenantId,
    slug: linha.c.slug,
    name: linha.c.name,
    items: linha.c.items,
    shippingCents: linha.c.shippingCents,
    methods: linha.c.methods,
    maxInstallments: linha.c.maxInstallments,
    config: linha.c.config,
    siteKey: linha.sitePublicKey ?? undefined,
    siteDomain: linha.siteDomain ?? undefined,
  };
}

/** Soma da oferta. Uma função só, para a tela e a cobrança nunca divergirem. */
export function totalDoCheckout(c: {
  items: Array<{ quantity: number; unitPriceCents: number }>;
  shippingCents: number;
}): { produtosCents: number; freteCents: number; totalCents: number } {
  const produtosCents = c.items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0);
  return {
    produtosCents,
    freteCents: c.shippingCents,
    totalCents: produtosCents + c.shippingCents,
  };
}

/* --------------------------------------------------------------- pagar -- */

export async function pagar(
  entrada: PedidoDoNavegador,
  ip: string,
): Promise<RespostaCheckout> {
  const invalido = (motivo: string): RespostaCheckout =>
    ({ ok: false, tipo: "invalido", motivo });

  /* ------------------------------------------------- o que foi enviado -- */
  const nome = (entrada.comprador.nome ?? "").trim();
  const email = (entrada.comprador.email ?? "").trim().toLowerCase();
  const telefone = (entrada.comprador.telefone ?? "").trim();
  const documento = (entrada.comprador.documento ?? "").trim();

  if (nome.split(/\s+/).filter(Boolean).length < 2) return invalido("Informe nome e sobrenome.");
  if (!EMAIL_RE.test(email)) return invalido("E-mail inválido.");
  if (soDigitos(telefone).length < 10) return invalido("Telefone inválido. Inclua o DDD.");
  if (!cpfValido(documento)) return invalido("CPF inválido.");

  const [checkout] = await db
    .select()
    .from(checkouts)
    .where(and(eq(checkouts.slug, entrada.slug), eq(checkouts.active, true)))
    .limit(1);

  if (!checkout) return invalido("Checkout indisponível.");
  if (checkout.items.length === 0) return invalido("Este checkout não tem produtos configurados.");
  if (!checkout.methods.includes(entrada.metodo)) {
    return invalido("Forma de pagamento não aceita neste checkout.");
  }

  /* ---------------------------------------------------------- limite -- */
  const barrado = await excedeuLimite(ip);
  if (barrado) return { ok: false, tipo: "limite", motivo: barrado };

  /* ------------------------------------------------------- pagamento -- */
  let pagamento: PagamentoPedido;

  if (entrada.metodo === "pix") {
    pagamento = { metodo: "pix" };
  } else {
    const token = (entrada.cartao?.token ?? "").trim();
    if (!token) return invalido("Não foi possível ler os dados do cartão. Tente novamente.");

    /*
     * Parcelas presas ao teto do checkout. Sem isso, alterar o campo no
     * navegador compraria em 24x numa oferta configurada para 12 — e cada
     * parcela extra sai da margem, porque a taxa da faixa é do lojista.
     */
    const pedidas = Number(entrada.parcelas ?? 1);
    const parcelas = Number.isInteger(pedidas) && pedidas >= 1
      ? Math.min(pedidas, checkout.maxInstallments)
      : 1;

    const titular = (entrada.cartao?.titular ?? nome).trim();
    const docTitular = (entrada.cartao?.documento ?? documento).trim();
    if (!cpfValido(docTitular)) return invalido("CPF do titular do cartão inválido.");

    pagamento = {
      metodo: "credit_card",
      token,
      titular,
      documentoTitular: docTitular,
      parcelas,
      softDescriptor: checkout.config.softDescriptor || undefined,
    };
  }

  /* ------------------------------------------------------- credenciais -- */
  const [conexao] = await db
    .select()
    .from(gatewayConnections)
    .where(eq(gatewayConnections.id, checkout.gatewayConnectionId))
    .limit(1);

  if (!conexao || !conexao.active) {
    return { ok: false, tipo: "erro", motivo: "Gateway não configurado." };
  }

  /*
   * Quem cobra sai da conexão, não de um nome escrito aqui. É o que permite
   * uma oferta cobrar pela Appmax e a de amanhã por outro gateway sem tocar
   * nesta função — e o que garante que a taxa aplicada seja a da conexão que
   * realmente processou.
   */
  const cobrador = cobradorDe(conexao.gateway);
  if (!cobrador) {
    return {
      ok: false, tipo: "erro",
      motivo: `O checkout próprio ainda não cobra pelo gateway "${conexao.gateway}".`,
    };
  }

  /* O gateway pode não fazer o que o checkout oferece — conferir antes de
     cobrar evita descobrir na recusa. */
  if (!cobrador.metodos.includes(entrada.metodo)) {
    return {
      ok: false, tipo: "erro",
      motivo: `${cobrador.rotulo} não aceita ${entrada.metodo === "pix" ? "pix" : "cartão"} por este checkout.`,
    };
  }

  const credenciais = await decryptRecord(conexao.credentials);

  /* ---------------------------------------------------------- cobrança -- */
  const totais = totalDoCheckout(checkout);

  const resultado = await cobrador.cobrar({
    credenciais,
    comprador: {
      nome, email, telefone, documento, ip,
      endereco: {
        cep: entrada.comprador.cep,
        rua: entrada.comprador.rua,
        numero: entrada.comprador.numero,
        complemento: entrada.comprador.complemento,
        bairro: entrada.comprador.bairro,
        cidade: entrada.comprador.cidade,
        estado: entrada.comprador.estado,
      },
    },
    itens: checkout.items,
    freteCents: totais.freteCents,
    pagamento,
  });

  /* ---------------------------------------------------------- registro -- */
  await db.insert(checkoutAttempts).values({
    tenantId: checkout.tenantId,
    checkoutId: checkout.id,
    ip,
    paymentMethod: entrada.metodo,
    outcome: resultado.ok ? "ok" : resultado.tipo,
    gatewayOrderId: resultado.gatewayOrderId ?? null,
    detail: resultado.ok ? null : resultado.motivo.slice(0, 300),
  });

  if (!resultado.ok) {
    return { ok: false, tipo: resultado.tipo, motivo: resultado.motivo };
  }

  /*
   * Tudo daqui para baixo é melhor-esforço, e de propósito.
   *
   * A cobrança já aconteceu — o cartão foi debitado, o pix foi emitido. Falhar
   * agora e devolver erro faria o comprador tentar de novo e pagar duas vezes.
   * O que se perde numa falha aqui é atribuição e sincronização, que a gente
   * recupera depois; o que se perderia devolvendo erro é a confiança de quem
   * acabou de pagar, que não volta.
   */
  const dadosDoComprador: Record<string, string | undefined> = {
    name: nome,
    email,
    phone: telefone,
    document: documento,
    zip: entrada.comprador.cep,
    street: entrada.comprador.rua,
    number: entrada.comprador.numero,
    complement: entrada.comprador.complemento,
    neighborhood: entrada.comprador.bairro,
    city: entrada.comprador.cidade,
    state: entrada.comprador.estado,
  };

  /*
   * O registro da venda própria.
   *
   * Guarda o que só existe neste instante: o comprador inteiro, o endereço, e
   * qual variante da Shopify é cada item. O webhook que confirma o pagamento
   * chega minutos depois — no pix, muito depois — sabendo só o id do pedido no
   * gateway, e é a partir desta linha que ele consegue criar o pedido na loja.
   */
  await registrarVendaPropria(checkout, conexao.id, resultado.gatewayOrderId, dadosDoComprador)
    .catch(() => { /* a sincronização se recupera; a venda não pode falhar */ });

  /*
   * A reivindicação: este pedido é daquele clique.
   *
   * Feita aqui e não pelo /api/claim porque o dono do pedido somos nós — não
   * há loja externa para avisar.
   */
  await reivindicar(
    checkout.tenantId, conexao.gateway, resultado.gatewayOrderId,
    entrada.clickId, dadosDoComprador,
  ).catch(() => { /* atribuição é melhor-esforço; a venda não é */ });

  return {
    ok: true,
    gatewayOrderId: resultado.gatewayOrderId,
    metodo: entrada.metodo,
    pix: resultado.pix,
    redirect: checkout.config.redirectUrl || undefined,
  };
}

/*
 * Grava o par (pedido, clique) e o que a loja sabe do comprador.
 *
 * O comprador vai cifrado campo a campo, como em qualquer dado pessoal em
 * repouso — e vale a pena porque destrava `ct`, `st` e `zp` no CAPI, três
 * chaves de correspondência que a Appmax não devolve em consulta nenhuma.
 */
async function reivindicar(
  tenantId: string,
  gateway: string,
  gatewayOrderId: string,
  clickId: string | undefined,
  dados: Record<string, string | undefined>,
): Promise<void> {
  if (!clickId || !UUID_RE.test(clickId)) return;

  /* A sessão precisa existir e ser desta loja — a chave estrangeira exige. */
  const [sessao] = await db
    .select({ id: clickSessions.clickId })
    .from(clickSessions)
    .where(and(eq(clickSessions.clickId, clickId), eq(clickSessions.tenantId, tenantId)))
    .limit(1);

  if (!sessao) return;

  /* Só as chaves que viram correspondência no CAPI. Rua e número não são
     chave de nada e não têm por que ser guardadas duas vezes. */
  const comprador = await cifrar(dados, [
    "name", "email", "phone", "document", "zip", "city", "state",
  ]);
  comprador.country = await encryptValue("br");

  await db.insert(orderClaims).values({
    tenantId,
    gateway,
    gatewayOrderId,
    clickId,
    customer: comprador,
  }).onConflictDoNothing();
}

/** Cifra campo a campo, pulando o que veio vazio. */
async function cifrar(
  dados: Record<string, string | undefined>,
  chaves: string[],
): Promise<Record<string, string>> {
  const saida: Record<string, string> = {};
  for (const chave of chaves) {
    const v = dados[chave];
    if (v && v.trim()) saida[chave] = await encryptValue(v.trim());
  }
  return saida;
}

/*
 * A linha que liga a cobrança de agora ao webhook de daqui a pouco.
 *
 * Os itens vão como cópia, não referência: o lojista muda preço e produto do
 * checkout quando quiser, e o pedido tem que continuar dizendo o que foi
 * vendido naquele dia. Sem a cópia, um ajuste de preço na terça reescreveria
 * o que foi enviado à Shopify na segunda.
 *
 * `onConflictDoNothing` porque a chave é (conexão, pedido): se a mesma cobrança
 * chegasse aqui duas vezes, a segunda não pode criar um segundo pedido na loja.
 */
async function registrarVendaPropria(
  checkout: {
    id: string;
    tenantId: string;
    shopifyConnectionId: string | null;
    items: Array<{ sku: string; name: string; quantity: number; unitPriceCents: number; shopifyVariantId?: string }>;
    shippingCents: number;
  },
  gatewayConnectionId: string,
  gatewayOrderId: string,
  dados: Record<string, string | undefined>,
): Promise<void> {
  const buyer = await cifrar(dados, [
    "name", "email", "phone", "document",
    "zip", "street", "number", "complement", "neighborhood", "city", "state",
  ]);

  await db.insert(checkoutOrders).values({
    tenantId: checkout.tenantId,
    checkoutId: checkout.id,
    gatewayConnectionId,
    gatewayOrderId,
    buyer,
    items: checkout.items.map((i) => ({
      sku: i.sku,
      name: i.name,
      quantity: i.quantity,
      unitPriceCents: i.unitPriceCents,
      shopifyVariantId: i.shopifyVariantId,
    })),
    shippingCents: checkout.shippingCents,
    shopifyConnectionId: checkout.shopifyConnectionId,
  }).onConflictDoNothing();
}

/* -------------------------------------------------------------- estado -- */

export type EstadoPedido = "aguardando" | "pago" | "recusado" | "cancelado";

/*
 * Em que pé está o pedido — para a tela do pix perguntar enquanto espera.
 *
 * Lê `orders`, que é escrita pelo webhook. Enquanto ele não chega, a resposta é
 * "aguardando", que é a verdade: pix pago só existe depois do aviso do gateway.
 */
export async function estadoDoPedido(
  slug: string,
  gatewayOrderId: string,
): Promise<EstadoPedido> {
  const [linha] = await db
    .select({ status: orders.status })
    .from(orders)
    .innerJoin(checkouts, eq(checkouts.gatewayConnectionId, orders.gatewayConnectionId))
    .where(and(
      eq(checkouts.slug, slug),
      eq(orders.gatewayOrderId, gatewayOrderId),
    ))
    .limit(1);

  if (!linha) return "aguardando";
  if (linha.status === "paid") return "pago";
  if (linha.status === "refused") return "recusado";
  if (linha.status === "canceled") return "cancelado";
  return "aguardando";
}
