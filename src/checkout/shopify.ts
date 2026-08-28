/*
 * A ponte com a Shopify.
 *
 * O checkout próprio resolve o pagamento, mas a loja continua sendo a Shopify:
 * é lá que mora o estoque, a etiqueta, o e-mail de confirmação e o histórico do
 * cliente. Um pagamento que não vira pedido lá é dinheiro recebido sem nada
 * saindo do galpão — o pior desfecho possível, porque ninguém reclama até o
 * comprador reclamar.
 *
 * Então esta ponte anda nos dois sentidos:
 *
 *   catálogo →  na hora de montar a oferta, produto e preço vêm de lá. Digitar
 *               o catálogo à mão nos dois lugares é garantir que um dia os dois
 *               discordem, e quem descobre a diferença é quem está pagando.
 *
 *   pedido   →  na hora que o webhook confirma, o pedido nasce lá, já pago.
 *
 * GraphQL e não REST: a REST Admin API virou legado em outubro de 2024, e a
 * criação de pedido por lá é exatamente o tipo de coisa que para de funcionar
 * numa quarta-feira sem aviso. `orderCreate` é o caminho que a Shopify mantém.
 *
 * O token é de app personalizado, criado pelo lojista no admin da própria loja,
 * e precisa dos escopos `read_products`, `write_orders` e `write_customers`.
 */

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/index";
import {
  checkoutOrders, checkouts, orders, shopifyConnections,
} from "../db/schema";
import { decryptRecord, decryptValue, encryptValue } from "../core/crypto";

/*
 * Versão fixa, de propósito.
 *
 * A Shopify publica uma versão por trimestre e cada uma vive nove meses. Apontar
 * para `latest` significa que o payload muda sozinho, num dia qualquer, sem uma
 * linha nossa ter mudado — e a falha aparece como pedido que deixou de entrar,
 * não como erro de compilação. Subir de versão é decisão, não efeito colateral.
 */
const VERSAO_API = "2025-10";

const MOEDA = "BRL";

/* ---------------------------------------------------------------- tipos -- */

export interface ConexaoShopify {
  id: string;
  shopDomain: string;
  label: string;
  active: boolean;
}

export interface VarianteShopify {
  /** GID completo: gid://shopify/ProductVariant/123. */
  id: string;
  titulo: string;
  sku: string | null;
  precoCents: number;
  disponivel: boolean;
}

export interface ProdutoShopify {
  id: string;
  titulo: string;
  status: string;
  variantes: VarianteShopify[];
}

type Falha = { ok: false; erro: string };

/* -------------------------------------------------------------- chamada -- */

/*
 * Uma chamada à Admin API.
 *
 * GraphQL responde 200 com o erro dentro do corpo, então checar o status HTTP
 * não basta: uma consulta recusada por falta de escopo chega como sucesso e o
 * `data` vem nulo. Quem chama nunca deve precisar lembrar disso.
 */
async function chamar<T>(
  shopDomain: string,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ ok: true; dados: T } | Falha> {
  let resposta: Response;

  try {
    resposta = await fetch(`https://${shopDomain}/admin/api/${VERSAO_API}/graphql.json`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (e) {
    return { ok: false, erro: `não deu para falar com a Shopify: ${msg(e)}` };
  }

  if (resposta.status === 401 || resposta.status === 403) {
    return { ok: false, erro: "token recusado pela Shopify. Confira se o app ainda existe e tem os escopos read_products, write_orders e write_customers." };
  }
  if (resposta.status === 404) {
    return { ok: false, erro: `loja "${shopDomain}" não encontrada na Shopify.` };
  }
  /*
   * 429 é limite de chamadas. Vale dizer explicitamente porque a mensagem crua
   * da Shopify não diz o que fazer, e a resposta certa aqui é só esperar — o
   * reenvio pendente pega este pedido na próxima rodada.
   */
  if (resposta.status === 429) {
    return { ok: false, erro: "limite de chamadas da Shopify atingido. Vai ser tentado de novo automaticamente." };
  }

  const texto = await resposta.text();

  if (!resposta.ok) {
    return { ok: false, erro: `Shopify respondeu ${resposta.status}: ${texto.slice(0, 200)}` };
  }

  let corpo: { data?: T; errors?: Array<{ message?: string }> };
  try {
    corpo = JSON.parse(texto) as typeof corpo;
  } catch {
    return { ok: false, erro: "resposta ilegível da Shopify." };
  }

  if (corpo.errors?.length) {
    return { ok: false, erro: corpo.errors.map((e) => e.message ?? "erro").join("; ").slice(0, 300) };
  }
  if (!corpo.data) {
    return { ok: false, erro: "a Shopify respondeu sem dados." };
  }

  return { ok: true, dados: corpo.data };
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/* ------------------------------------------------------------- conexões -- */

/* O domínio interno, sempre. O de vitrine muda; este não. */
export function normalizarDominio(bruto: string): string {
  let d = bruto.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\s/g, "");
  if (d && !d.includes(".")) d = `${d}.myshopify.com`;
  return d;
}

const DOMINIO_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/*
 * Liga uma loja da Shopify — e prova que ligou.
 *
 * Guardar o token sem usá-lo aceita credencial errada em silêncio, e o erro só
 * apareceria na primeira venda, que é o pior momento possível para descobrir.
 * Uma consulta a `shop` custa nada e confirma domínio, token e conectividade de
 * uma vez.
 */
export async function conectarShopify(
  tenantId: string,
  dominioBruto: string,
  token: string,
): Promise<{ ok: true; id: string; label: string } | Falha> {
  const shopDomain = normalizarDominio(dominioBruto);

  if (!DOMINIO_RE.test(shopDomain)) {
    return { ok: false, erro: 'Domínio inválido. Use o endereço interno da loja, como "minhaloja.myshopify.com".' };
  }
  /*
   * Os tokens de app personalizado começam com `shpat_`. Conferir aqui separa
   * "colei a chave errada" de "a Shopify recusou", que são problemas com
   * soluções diferentes e mensagens de erro parecidas.
   */
  const limpo = token.trim();
  if (!limpo) return { ok: false, erro: "Informe o token de acesso da Admin API." };
  if (!limpo.startsWith("shpat_")) {
    return { ok: false, erro: 'Esse não parece o token certo. O token da Admin API começa com "shpat_" e aparece uma única vez, quando o app personalizado é instalado.' };
  }

  const r = await chamar<{ shop: { name: string; currencyCode: string } }>(
    shopDomain, limpo,
    "{ shop { name currencyCode } }",
    {},
  );
  if (!r.ok) return r;

  const label = r.dados.shop.name || shopDomain;

  /*
   * A moeda da loja tem que ser a mesma que o gateway cobra. Se a Shopify está
   * em dólar e a Appmax cobra em real, o pedido entra lá com o número certo e a
   * moeda errada — e o faturamento da loja fica cinco vezes maior sem ninguém
   * notar de imediato.
   */
  if (r.dados.shop.currencyCode && r.dados.shop.currencyCode !== MOEDA) {
    return {
      ok: false,
      erro: `Esta loja da Shopify fatura em ${r.dados.shop.currencyCode}, e o checkout cobra em ${MOEDA}. Ligar as duas registraria o pedido com a moeda errada.`,
    };
  }

  const credentials = { accessToken: await encryptValue(limpo) };

  const [linha] = await db.insert(shopifyConnections)
    .values({ tenantId, shopDomain, label, credentials, active: true })
    .onConflictDoUpdate({
      target: [shopifyConnections.tenantId, shopifyConnections.shopDomain],
      set: { label, credentials, active: true, updatedAt: new Date() },
    })
    .returning({ id: shopifyConnections.id });

  if (!linha) return { ok: false, erro: "Não foi possível gravar a conexão." };
  return { ok: true, id: linha.id, label };
}

export async function listarConexoesShopify(tenantId: string): Promise<ConexaoShopify[]> {
  return db.select({
    id: shopifyConnections.id,
    shopDomain: shopifyConnections.shopDomain,
    label: shopifyConnections.label,
    active: shopifyConnections.active,
  })
    .from(shopifyConnections)
    .where(eq(shopifyConnections.tenantId, tenantId))
    .orderBy(asc(shopifyConnections.createdAt));
}

export async function desconectarShopify(tenantId: string, id: string): Promise<boolean> {
  const apagadas = await db.delete(shopifyConnections)
    .where(and(eq(shopifyConnections.id, id), eq(shopifyConnections.tenantId, tenantId)))
    .returning({ id: shopifyConnections.id });
  return apagadas.length > 0;
}

/* Busca a conexão e abre o token. Sempre por tenant: id colado no corpo do POST
   não pode alcançar a loja de outro lojista. */
async function credenciais(
  tenantId: string,
  id: string,
): Promise<{ ok: true; shopDomain: string; token: string } | Falha> {
  const [c] = await db.select()
    .from(shopifyConnections)
    .where(and(eq(shopifyConnections.id, id), eq(shopifyConnections.tenantId, tenantId)))
    .limit(1);

  if (!c) return { ok: false, erro: "Loja da Shopify não encontrada." };
  if (!c.active) return { ok: false, erro: "Esta conexão com a Shopify está desativada." };

  const abertas = await decryptRecord(c.credentials);
  const token = abertas.accessToken;
  if (!token) return { ok: false, erro: "Conexão sem token. Ligue a loja de novo." };

  return { ok: true, shopDomain: c.shopDomain, token };
}

/* ------------------------------------------------------------- catálogo -- */

const QUERY_PRODUTOS = `
query($busca: String, $cursor: String) {
  products(first: 25, after: $cursor, query: $busca, sortKey: UPDATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      title
      status
      variants(first: 100) {
        nodes { id title sku price availableForSale }
      }
    }
  }
}`;

interface RespostaProdutos {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{
      id: string;
      title: string;
      status: string;
      variants: { nodes: Array<{ id: string; title: string; sku: string | null; price: string; availableForSale: boolean }> };
    }>;
  };
}

/*
 * O preço na Shopify é decimal em texto ("97.00"). Converter por
 * `Number(x) * 100` erra por um centavo em valores como 19.99, porque 19.99 não
 * existe exatamente em ponto flutuante — e um centavo a menos no preço é uma
 * divergência que aparece na conciliação e ninguém acha a origem.
 */
export function precoParaCentavos(texto: string): number {
  const limpo = (texto ?? "").trim();
  if (!limpo) return 0;

  const negativo = limpo.startsWith("-");
  const [inteiro = "0", decimal = ""] = limpo.replace(/^-/, "").split(".");
  const centavos = (decimal + "00").slice(0, 2);
  const valor = Number(inteiro) * 100 + Number(centavos);

  return Number.isFinite(valor) ? (negativo ? -valor : valor) : 0;
}

/** O caminho de volta: centavos para o texto que a Shopify espera. */
export function centavosParaPreco(cents: number): string {
  const sinal = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sinal}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export async function listarProdutosShopify(
  tenantId: string,
  conexaoId: string,
  busca?: string,
  cursor?: string,
): Promise<{ ok: true; produtos: ProdutoShopify[]; proximo: string | null } | Falha> {
  const cred = await credenciais(tenantId, conexaoId);
  if (!cred.ok) return cred;

  const r = await chamar<RespostaProdutos>(cred.shopDomain, cred.token, QUERY_PRODUTOS, {
    busca: busca?.trim() ? `title:*${busca.trim()}*` : null,
    cursor: cursor ?? null,
  });
  if (!r.ok) return r;

  const produtos = r.dados.products.nodes.map((p) => ({
    id: p.id,
    titulo: p.title,
    status: p.status,
    variantes: p.variants.nodes.map((v) => ({
      id: v.id,
      titulo: v.title,
      sku: v.sku || null,
      precoCents: precoParaCentavos(v.price),
      disponivel: v.availableForSale,
    })),
  }));

  return {
    ok: true,
    produtos,
    proximo: r.dados.products.pageInfo.hasNextPage ? r.dados.products.pageInfo.endCursor : null,
  };
}

/* --------------------------------------------------------------- pedido -- */

const MUTATION_PEDIDO = `
mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
  orderCreate(order: $order, options: $options) {
    userErrors { field message }
    order { id name }
  }
}`;

/*
 * Nome em duas partes.
 *
 * A Shopify guarda primeiro e último nome separados; o checkout pede um campo
 * só, porque dois campos custam conversão. O primeiro espaço decide, e o resto
 * inteiro vai para o sobrenome — "Maria da Silva Santos" tem sobrenome "da
 * Silva Santos", que é o que ela escreveria se perguntassem.
 */
export function partirNome(inteiro: string): { primeiro: string; ultimo: string } {
  const partes = (inteiro ?? "").trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return { primeiro: "", ultimo: "" };
  if (partes.length === 1) return { primeiro: partes[0]!, ultimo: "" };
  return { primeiro: partes[0]!, ultimo: partes.slice(1).join(" ") };
}

/*
 * Telefone no formato que a Shopify aceita, ou nenhum.
 *
 * Ela valida E.164 e recusa o pedido inteiro quando o número não passa — perder
 * a venda na loja por causa de um telefone mal digitado seria absurdo. Aqui,
 * número que não vira E.164 confiável simplesmente não vai: o pedido entra sem
 * telefone, que é uma perda pequena e recuperável.
 */
export function telefoneE164(bruto: string | undefined): string | undefined {
  const d = (bruto ?? "").replace(/\D/g, "");
  if (!d) return undefined;

  /* Já veio com o país. */
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) return `+${d}`;
  /* DDD + 8 (fixo) ou 9 (celular) dígitos. */
  if (d.length === 10 || d.length === 11) return `+55${d}`;

  return undefined;
}

/* Aceita tanto o GID quanto o id cru, para o dado gravado à mão não quebrar. */
export function gidVariante(bruto: string): string {
  const v = bruto.trim();
  if (!v) return "";
  if (v.startsWith("gid://")) return v;
  return `gid://shopify/ProductVariant/${v.replace(/\D/g, "")}`;
}

interface RespostaPedido {
  orderCreate: {
    userErrors: Array<{ field?: string[] | null; message?: string }>;
    order: { id: string; name: string } | null;
  } | null;
}

export interface DadosDoPedido {
  buyer: Record<string, string>;
  items: Array<{ sku: string; name: string; quantity: number; unitPriceCents: number; shopifyVariantId?: string }>;
  shippingCents: number;
  gatewayOrderId: string;
  gateway: string;
}

/*
 * Monta o input do `orderCreate`.
 *
 * Fora da função que chama a rede, para poder ser conferido em teste sem tocar
 * na Shopify — é onde moram os erros que só apareceriam na primeira venda de
 * verdade.
 */
export function montarPedido(d: DadosDoPedido): {
  order: Record<string, unknown>;
  options: Record<string, unknown>;
} {
  const dinheiro = (cents: number) => ({
    shopMoney: { amount: centavosParaPreco(cents), currencyCode: MOEDA },
  });

  const { primeiro, ultimo } = partirNome(d.buyer.name ?? "");
  const telefone = telefoneE164(d.buyer.phone);

  const endereco = {
    firstName: primeiro || undefined,
    lastName: ultimo || undefined,
    address1: [d.buyer.street, d.buyer.number].filter(Boolean).join(", ") || undefined,
    address2: d.buyer.complement || undefined,
    city: d.buyer.city || undefined,
    /* A Shopify quer a sigla do estado, que é exatamente o que o CEP devolve. */
    provinceCode: d.buyer.state ? d.buyer.state.toUpperCase().slice(0, 2) : undefined,
    zip: d.buyer.zip || undefined,
    countryCode: "BR",
    phone: telefone,
  };

  const temEndereco = Boolean(endereco.address1 && endereco.city && endereco.zip);

  const lineItems = d.items.map((i) => {
    const preco = dinheiro(i.unitPriceCents);
    /*
     * Com variante, o pedido cai no produto certo e o estoque anda. Sem ela —
     * uma order bump digitada à mão, por exemplo — entra como item avulso, que
     * a Shopify aceita mas não desconta de estoque nenhum.
     */
    return i.shopifyVariantId
      ? { variantId: gidVariante(i.shopifyVariantId), quantity: i.quantity, priceSet: preco }
      : { title: i.name, quantity: i.quantity, priceSet: preco };
  });

  const produtos = d.items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0);
  const total = produtos + d.shippingCents;

  const order: Record<string, unknown> = {
    email: d.buyer.email || undefined,
    phone: telefone,
    currency: MOEDA,
    financialStatus: "PAID",
    lineItems,
    /*
     * A transação é o que faz o dinheiro aparecer nos relatórios da Shopify.
     * Só `financialStatus: PAID` marca o pedido como pago mas deixa o valor
     * recebido zerado, e aí o faturamento de lá nunca bate com o daqui.
     */
    transactions: [{ kind: "SALE", status: "SUCCESS", amountSet: dinheiro(total) }],
    tags: ["RRTrack", `gateway:${d.gateway}`],
    /* O id do gateway no pedido é o que permite achar a origem de um estorno
       meses depois, olhando só a tela da Shopify. */
    note: `Pago pelo checkout RRTrack via ${d.gateway} · pedido ${d.gatewayOrderId}`,
    sourceName: "RRTrack",
  };

  if (d.shippingCents > 0) {
    order.shippingLines = [{ title: "Frete", priceSet: dinheiro(d.shippingCents) }];
  }

  if (d.buyer.email) {
    order.customer = {
      toUpsert: {
        email: d.buyer.email,
        firstName: primeiro || undefined,
        lastName: ultimo || undefined,
      },
    };
  }

  /* Endereço incompleto some inteiro: meio endereço faz a Shopify recusar o
     pedido, e a venda já aconteceu. Melhor entrar sem e o lojista completar. */
  if (temEndereco) {
    order.shippingAddress = endereco;
    order.billingAddress = endereco;
  }

  return {
    order,
    options: {
      /* Baixa estoque respeitando a política de venda sem estoque da loja —
         nunca ignorando, que criaria estoque negativo à revelia do lojista. */
      inventoryBehaviour: "DECREMENT_OBEYING_POLICY",
      /* Quem avisa o comprador é a Shopify, com o template da loja. O checkout
         não manda e-mail nenhum justamente para não haver dois. */
      sendReceipt: true,
    },
  };
}

/* ---------------------------------------------------------- sincronizar -- */

/*
 * Cria na Shopify o pedido que já foi pago.
 *
 * Idempotente por construção, e precisa ser: o webhook do gateway reentrega,
 * a reconciliação roda de novo, e a Shopify não tem chave de idempotência em
 * `orderCreate` — dois envios criam dois pedidos, dois envios e duas etiquetas.
 * A trava é `shopifySyncedAt`: linha já sincronizada sai na primeira condição,
 * sem tocar na rede.
 *
 * Nunca lança. Quem chama está no caminho de uma venda que já entrou, e derrubar
 * o processamento por causa da Shopify perderia o webhook inteiro.
 */
export async function sincronizarPedidoShopify(
  gatewayConnectionId: string,
  gatewayOrderId: string,
): Promise<{ ok: true; shopifyOrderId: string; nome: string } | { ok: false; erro: string; jaFeito?: boolean }> {
  const [registro] = await db.select()
    .from(checkoutOrders)
    .where(and(
      eq(checkoutOrders.gatewayConnectionId, gatewayConnectionId),
      eq(checkoutOrders.gatewayOrderId, gatewayOrderId),
    ))
    .limit(1);

  /* Venda que não passou pelo nosso checkout não tem o que sincronizar. */
  if (!registro) return { ok: false, erro: "venda não veio do checkout próprio", jaFeito: true };

  if (registro.shopifySyncedAt && registro.shopifyOrderId) {
    return { ok: true, shopifyOrderId: registro.shopifyOrderId, nome: registro.shopifyOrderName ?? "" };
  }

  /* Checkout sem Shopify ligada: nada a fazer, e não é erro. */
  const conexaoId = registro.shopifyConnectionId;
  if (!conexaoId) return { ok: false, erro: "checkout sem loja da Shopify ligada", jaFeito: true };

  const falhar = async (erro: string) => {
    await db.update(checkoutOrders)
      .set({ syncError: erro.slice(0, 500), syncAttempts: sql`${checkoutOrders.syncAttempts} + 1` })
      .where(eq(checkoutOrders.id, registro.id));
    return { ok: false as const, erro };
  };

  const cred = await credenciais(registro.tenantId, conexaoId);
  if (!cred.ok) return falhar(cred.erro);

  /* O comprador está cifrado em repouso; abre só aqui, para montar o pedido. */
  let buyer: Record<string, string>;
  try {
    buyer = await decryptRecord(registro.buyer);
  } catch (e) {
    return falhar(`não deu para ler os dados do comprador: ${msg(e)}`);
  }

  const entrada = montarPedido({
    buyer,
    items: registro.items,
    shippingCents: registro.shippingCents,
    gatewayOrderId: registro.gatewayOrderId,
    gateway: "appmax",
  });

  const r = await chamar<RespostaPedido>(
    cred.shopDomain, cred.token, MUTATION_PEDIDO,
    { order: entrada.order, options: entrada.options },
  );
  if (!r.ok) return falhar(r.erro);

  const resultado = r.dados.orderCreate;
  if (!resultado) return falhar("a Shopify não devolveu resultado da criação.");

  if (resultado.userErrors?.length) {
    const detalhe = resultado.userErrors
      .map((u) => `${(u.field ?? []).join(".")}: ${u.message ?? ""}`.trim())
      .join(" | ");
    return falhar(`a Shopify recusou o pedido — ${detalhe}`);
  }

  if (!resultado.order?.id) return falhar("a Shopify aceitou mas não devolveu o pedido.");

  await db.update(checkoutOrders)
    .set({
      shopifyOrderId: resultado.order.id,
      shopifyOrderName: resultado.order.name ?? null,
      shopifySyncedAt: new Date(),
      syncError: null,
      syncAttempts: sql`${checkoutOrders.syncAttempts} + 1`,
    })
    .where(eq(checkoutOrders.id, registro.id));

  return { ok: true, shopifyOrderId: resultado.order.id, nome: resultado.order.name ?? "" };
}

/*
 * Segunda chance para o que ficou pelo caminho.
 *
 * A Shopify cai, o limite de chamadas estoura, o token expira num domingo. Sem
 * isto, cada uma dessas é uma venda paga que nunca vira pedido, e a descoberta
 * vem pelo comprador perguntando onde está a encomenda.
 *
 * Pega carona no webhook, como o resto do reenvio: chegou venda quer dizer que
 * há movimento, e é quando vale gastar alguns segundos com o que ficou para
 * trás. Só olha pedido efetivamente pago — pix pendente não tem o que criar.
 */
export async function reenviarPendentesShopify(tenantId: string, limite = 5): Promise<number> {
  const pendentes = await db.select({
    conexao: checkoutOrders.gatewayConnectionId,
    pedido: checkoutOrders.gatewayOrderId,
  })
    .from(checkoutOrders)
    .innerJoin(orders, and(
      eq(orders.gatewayConnectionId, checkoutOrders.gatewayConnectionId),
      eq(orders.gatewayOrderId, checkoutOrders.gatewayOrderId),
    ))
    .where(and(
      eq(checkoutOrders.tenantId, tenantId),
      isNull(checkoutOrders.shopifySyncedAt),
      sql`${checkoutOrders.shopifyConnectionId} is not null`,
      eq(orders.status, "paid"),
      /*
       * Teto de tentativas. Erro que não é temporário — variante apagada, loja
       * desligada — não melhora tentando de novo, e sem teto ele voltaria a
       * cada webhook para sempre, gastando chamada e escondendo os pendentes
       * que ainda têm chance.
       */
      sql`${checkoutOrders.syncAttempts} < 8`,
    ))
    .orderBy(asc(checkoutOrders.createdAt))
    .limit(limite);

  let feitos = 0;
  for (const p of pendentes) {
    const r = await sincronizarPedidoShopify(p.conexao, p.pedido);
    if (r.ok) feitos++;
  }
  return feitos;
}

/* ---------------------------------------------------------------- painel -- */

export interface PedidoNaShopify {
  gatewayOrderId: string;
  criadoEm: Date;
  totalCents: number;
  checkoutNome: string;
  shopifyOrderName: string | null;
  sincronizadoEm: Date | null;
  erro: string | null;
  tentativas: number;
}

/*
 * O que o painel precisa mostrar: as vendas do checkout e se cada uma chegou
 * na Shopify. A linha que importa é a que tem erro — venda paga que a loja não
 * conhece é a única falha aqui que custa dinheiro de verdade.
 */
export async function pedidosDoCheckout(tenantId: string, limite = 50): Promise<PedidoNaShopify[]> {
  const linhas = await db.select({
    gatewayOrderId: checkoutOrders.gatewayOrderId,
    criadoEm: checkoutOrders.createdAt,
    items: checkoutOrders.items,
    shippingCents: checkoutOrders.shippingCents,
    checkoutNome: checkouts.name,
    shopifyOrderName: checkoutOrders.shopifyOrderName,
    sincronizadoEm: checkoutOrders.shopifySyncedAt,
    erro: checkoutOrders.syncError,
    tentativas: checkoutOrders.syncAttempts,
    temShopify: checkoutOrders.shopifyConnectionId,
  })
    .from(checkoutOrders)
    .innerJoin(checkouts, eq(checkouts.id, checkoutOrders.checkoutId))
    .where(eq(checkoutOrders.tenantId, tenantId))
    .orderBy(sql`${checkoutOrders.createdAt} desc`)
    .limit(limite);

  return linhas.map((l) => ({
    gatewayOrderId: l.gatewayOrderId,
    criadoEm: l.criadoEm,
    totalCents: l.items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0) + l.shippingCents,
    checkoutNome: l.checkoutNome,
    shopifyOrderName: l.shopifyOrderName,
    sincronizadoEm: l.sincronizadoEm,
    /* Sem Shopify ligada não é pendência: é oferta de página própria. */
    erro: l.temShopify ? l.erro : null,
    tentativas: l.tentativas,
  }));
}
