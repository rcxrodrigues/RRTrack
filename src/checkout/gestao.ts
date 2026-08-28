/*
 * Criar, editar e listar checkouts — o lado do lojista.
 *
 * Separado de `index.ts` porque as duas metades têm exigências opostas. Lá o
 * chamador é anônimo e tudo que ele manda é suspeito; aqui o chamador está
 * autenticado e o que ele manda é a configuração da própria loja. Misturar as
 * duas no mesmo arquivo é como se perde de vista qual validação protege o quê.
 */

import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "../db/index";
import {
  checkoutAttempts, checkouts, gatewayConnections, shopifyConnections, sites,
} from "../db/schema";
import { cobradorDe } from "./cobradores";

export interface ItemDoCheckout {
  sku: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  digital?: boolean;
  /** A variante na Shopify, quando o item foi importado de lá. */
  shopifyVariantId?: string;
}

export interface CheckoutNaLista {
  id: string;
  slug: string;
  name: string;
  active: boolean;
  gatewayConnectionId: string;
  gateway: string;
  gatewayLabel: string;
  siteId: string | null;
  shopifyConnectionId: string | null;
  items: ItemDoCheckout[];
  shippingCents: number;
  methods: string[];
  maxInstallments: number;
  config: Record<string, string>;
  totalCents: number;
  /* Últimos sete dias, para a linha da lista dizer se está vendendo. */
  tentativas: number;
  aprovadas: number;
}

export interface OpcoesDoFormulario {
  /*
   * Só as conexões que sabem cobrar. Listar as outras ofereceria uma escolha
   * que o formulário recusaria depois — receber webhook e iniciar cobrança são
   * capacidades diferentes, e o painel não deve fingir que são a mesma.
   */
  conexoes: Array<{ id: string; gateway: string; label: string; metodos: string[] }>;
  sites: Array<{ id: string; domain: string }>;
  lojasShopify: Array<{ id: string; shopDomain: string; label: string }>;
}

/* --------------------------------------------------------------- listar -- */

export async function listarCheckouts(tenantId: string): Promise<CheckoutNaLista[]> {
  const linhas = await db
    .select({
      c: checkouts,
      gateway: gatewayConnections.gateway,
      gatewayLabel: gatewayConnections.label,
    })
    .from(checkouts)
    .innerJoin(gatewayConnections, eq(gatewayConnections.id, checkouts.gatewayConnectionId))
    .where(eq(checkouts.tenantId, tenantId))
    .orderBy(desc(checkouts.createdAt));

  if (linhas.length === 0) return [];

  /*
   * Tentativas dos últimos sete dias, numa consulta só.
   *
   * Uma por checkout seria N idas ao banco para desenhar uma lista — e a lista
   * é a primeira tela, aquela que abre toda vez.
   */
  const desde = new Date(Date.now() - 7 * 864e5);
  const contagem = await db
    .select({
      checkoutId: checkoutAttempts.checkoutId,
      total: sql<number>`count(*)::int`,
      ok: sql<number>`count(*) filter (where ${checkoutAttempts.outcome} = 'ok')::int`,
    })
    .from(checkoutAttempts)
    .where(and(
      eq(checkoutAttempts.tenantId, tenantId),
      sql`${checkoutAttempts.createdAt} >= ${desde}`,
    ))
    .groupBy(checkoutAttempts.checkoutId);

  const por = new Map(contagem.map((c) => [c.checkoutId, c]));

  return linhas.map(({ c, gateway, gatewayLabel }) => ({
    id: c.id,
    slug: c.slug,
    name: c.name,
    active: c.active,
    gatewayConnectionId: c.gatewayConnectionId,
    gateway,
    gatewayLabel,
    siteId: c.siteId,
    shopifyConnectionId: c.shopifyConnectionId,
    items: c.items,
    shippingCents: c.shippingCents,
    methods: c.methods,
    maxInstallments: c.maxInstallments,
    config: c.config,
    totalCents: c.items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0) + c.shippingCents,
    tentativas: por.get(c.id)?.total ?? 0,
    aprovadas: por.get(c.id)?.ok ?? 0,
  }));
}

export async function opcoesDoFormulario(tenantId: string): Promise<OpcoesDoFormulario> {
  const [conexoes, listaSites, lojasShopify] = await Promise.all([
    db.select({
      id: gatewayConnections.id,
      gateway: gatewayConnections.gateway,
      label: gatewayConnections.label,
    })
      .from(gatewayConnections)
      .where(and(eq(gatewayConnections.tenantId, tenantId), eq(gatewayConnections.active, true))),

    db.select({ id: sites.id, domain: sites.domain })
      .from(sites)
      .where(eq(sites.tenantId, tenantId)),

    db.select({
      id: shopifyConnections.id,
      shopDomain: shopifyConnections.shopDomain,
      label: shopifyConnections.label,
    })
      .from(shopifyConnections)
      .where(and(eq(shopifyConnections.tenantId, tenantId), eq(shopifyConnections.active, true))),
  ]);

  const podemCobrar = conexoes.flatMap((c) => {
    const cobrador = cobradorDe(c.gateway);
    return cobrador ? [{ ...c, metodos: cobrador.metodos as string[] }] : [];
  });

  return { conexoes: podemCobrar, sites: listaSites, lojasShopify };
}

/* --------------------------------------------------------------- gravar -- */

export interface CheckoutEnviado {
  id?: string;
  name?: string;
  slug?: string;
  gatewayConnectionId?: string;
  siteId?: string | null;
  shopifyConnectionId?: string | null;
  items?: unknown;
  shippingCents?: number;
  methods?: unknown;
  maxInstallments?: number;
  config?: Record<string, unknown>;
  active?: boolean;
}

export type ResultadoGravacao =
  | { ok: true; id: string; slug: string }
  | { ok: false; erro: string };

/*
 * O slug vira endereço público, então precisa ser previsível: minúsculas, sem
 * acento, hífen no lugar de espaço. Deixar a pessoa digitar livremente daria
 * URLs que quebram ao serem coladas no WhatsApp.
 */
export function normalizarSlug(bruto: string): string {
  return bruto
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/* Nomes que colidiriam com rotas nossas ou confundiriam quem lê a URL. */
const RESERVADOS = new Set(["api", "c", "entrar", "rr", "admin", "checkout"]);

function lerItens(bruto: unknown): ItemDoCheckout[] | string {
  if (!Array.isArray(bruto) || bruto.length === 0) {
    return "Adicione ao menos um produto.";
  }

  const itens: ItemDoCheckout[] = [];
  for (const cru of bruto) {
    if (!cru || typeof cru !== "object") return "Produto inválido.";
    const o = cru as Record<string, unknown>;

    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!name) return "Todo produto precisa de nome.";

    const quantity = Number(o.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1) {
      return `Quantidade inválida em "${name}".`;
    }

    const preco = Number(o.unitPriceCents);
    if (!Number.isInteger(preco) || preco < 0) {
      return `Preço inválido em "${name}".`;
    }
    /*
     * Teto de R$ 500 mil por unidade. Não é limite de negócio: é rede contra
     * digitar o valor em centavos onde se esperava reais, que passaria batido
     * e cobraria cem vezes mais de quem comprasse.
     */
    if (preco > 50_000_000) return `Preço muito alto em "${name}". Confira a vírgula.`;

    itens.push({
      sku: typeof o.sku === "string" && o.sku.trim() ? o.sku.trim() : name.slice(0, 40),
      name,
      quantity,
      unitPriceCents: preco,
      digital: o.digital === true,
      shopifyVariantId: typeof o.shopifyVariantId === "string" && o.shopifyVariantId.trim()
        ? o.shopifyVariantId.trim() : undefined,
    });
  }
  return itens;
}

const METODOS_VALIDOS = new Set(["pix", "credit_card"]);

const CHAVES_CONFIG = [
  "cor", "logoUrl", "redirectUrl", "supportEmail",
  "softDescriptor", "appmaxExternalId",
] as const;

export async function gravarCheckout(
  tenantId: string,
  enviado: CheckoutEnviado,
): Promise<ResultadoGravacao> {
  const name = (enviado.name ?? "").trim();
  if (!name) return { ok: false, erro: "Dê um nome ao checkout." };

  const slug = normalizarSlug(enviado.slug || name);
  if (slug.length < 3) return { ok: false, erro: "O endereço precisa de ao menos 3 caracteres." };
  if (RESERVADOS.has(slug)) return { ok: false, erro: `"${slug}" é reservado. Escolha outro endereço.` };

  const itens = lerItens(enviado.items);
  if (typeof itens === "string") return { ok: false, erro: itens };

  const metodos = Array.isArray(enviado.methods)
    ? enviado.methods.filter((m): m is string => typeof m === "string" && METODOS_VALIDOS.has(m))
    : [];
  if (metodos.length === 0) return { ok: false, erro: "Escolha ao menos uma forma de pagamento." };

  const conexaoId = (enviado.gatewayConnectionId ?? "").trim();
  if (!conexaoId) return { ok: false, erro: "Escolha por qual gateway o dinheiro entra." };

  /* A conexão precisa ser desta loja — sem isso, um id colado no corpo do POST
     ligaria o checkout à conta de outro lojista. */
  const [conexao] = await db
    .select({ id: gatewayConnections.id, gateway: gatewayConnections.gateway })
    .from(gatewayConnections)
    .where(and(eq(gatewayConnections.id, conexaoId), eq(gatewayConnections.tenantId, tenantId)))
    .limit(1);

  if (!conexao) return { ok: false, erro: "Gateway não encontrado nesta loja." };

  /* Nem todo gateway integrado sabe cobrar: receber webhook e iniciar cobrança
     são coisas diferentes, e só a segunda precisa de driver. */
  const cobrador = cobradorDe(conexao.gateway);
  if (!cobrador) {
    return {
      ok: false,
      erro: `O checkout próprio ainda não cobra pelo gateway "${conexao.gateway}". Ele continua recebendo vendas por webhook normalmente.`,
    };
  }

  /* Método que o gateway não faz não pode ser oferecido: o comprador só
     descobriria ao ser recusado, depois de preencher tudo. */
  const semSuporte = metodos.filter((m) => !cobrador.metodos.includes(m as never));
  if (semSuporte.length > 0) {
    return {
      ok: false,
      erro: `${cobrador.rotulo} não aceita ${semSuporte.join(" nem ")} por este checkout.`,
    };
  }

  const shopifyConnectionId = enviado.shopifyConnectionId
    ? String(enviado.shopifyConnectionId) : null;

  if (shopifyConnectionId) {
    const [loja] = await db
      .select({ id: shopifyConnections.id })
      .from(shopifyConnections)
      .where(and(
        eq(shopifyConnections.id, shopifyConnectionId),
        eq(shopifyConnections.tenantId, tenantId),
      ))
      .limit(1);
    if (!loja) return { ok: false, erro: "Loja da Shopify não encontrada nesta loja." };

    /*
     * Vender item sem variante numa oferta ligada à Shopify entra lá como linha
     * avulsa e não baixa estoque — o pedido aparece, o produto continua
     * disponível, e a loja vende o que não tem. Vale barrar na configuração,
     * onde ainda dá para corrigir.
     */
    const semVariante = itens.filter((i) => !i.shopifyVariantId).map((i) => i.name);
    if (semVariante.length > 0) {
      return {
        ok: false,
        erro: `Estes produtos não vieram da Shopify e não baixariam estoque: ${semVariante.join(", ")}. Importe-os da loja ou desligue a integração neste checkout.`,
      };
    }
  }

  const siteId = enviado.siteId ? String(enviado.siteId) : null;
  if (siteId) {
    const [site] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, siteId), eq(sites.tenantId, tenantId)))
      .limit(1);
    if (!site) return { ok: false, erro: "Site não encontrado nesta loja." };
  }

  const frete = Number(enviado.shippingCents ?? 0);
  if (!Number.isInteger(frete) || frete < 0) return { ok: false, erro: "Frete inválido." };

  const parcelas = Number(enviado.maxInstallments ?? 12);
  const maxInstallments = Number.isInteger(parcelas) && parcelas >= 1
    ? Math.min(parcelas, 12) : 12;

  const config: Record<string, string> = {};
  for (const chave of CHAVES_CONFIG) {
    const v = enviado.config?.[chave];
    if (typeof v === "string" && v.trim()) config[chave] = v.trim();
  }

  /* Slug único: a URL é a identidade pública, não pode haver duas. */
  const conflito = await db
    .select({ id: checkouts.id })
    .from(checkouts)
    .where(enviado.id
      ? and(eq(checkouts.slug, slug), ne(checkouts.id, enviado.id))
      : eq(checkouts.slug, slug))
    .limit(1);

  if (conflito.length > 0) {
    return { ok: false, erro: `O endereço "/c/${slug}" já está em uso.` };
  }

  const valores = {
    tenantId,
    slug,
    name,
    gatewayConnectionId: conexaoId,
    siteId,
    shopifyConnectionId,
    items: itens,
    shippingCents: frete,
    methods: metodos,
    maxInstallments,
    config,
    active: enviado.active !== false,
    updatedAt: new Date(),
  };

  if (enviado.id) {
    const [linha] = await db.update(checkouts)
      .set(valores)
      .where(and(eq(checkouts.id, enviado.id), eq(checkouts.tenantId, tenantId)))
      .returning({ id: checkouts.id });

    if (!linha) return { ok: false, erro: "Checkout não encontrado." };
    return { ok: true, id: linha.id, slug };
  }

  const [linha] = await db.insert(checkouts).values(valores).returning({ id: checkouts.id });
  if (!linha) return { ok: false, erro: "Não foi possível criar o checkout." };
  return { ok: true, id: linha.id, slug };
}

export async function excluirCheckout(tenantId: string, id: string): Promise<boolean> {
  const apagados = await db.delete(checkouts)
    .where(and(eq(checkouts.id, id), eq(checkouts.tenantId, tenantId)))
    .returning({ id: checkouts.id });
  return apagados.length > 0;
}
