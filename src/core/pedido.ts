/*
 * Gravar uma venda e disparar a conversão.
 *
 * Isto morava dentro da rota de webhook, e saiu de lá quando a reconciliação
 * passou a precisar do mesmo caminho. Duplicar as regras seria pedir para as
 * duas cópias divergirem: bastaria alguém arrumar a ordem de estados num lado e
 * a venda recuperada passaria a entrar com regra antiga, sem nada acusando.
 *
 * O que este módulo garante, venha a venda de onde vier:
 *
 *   - o estado só avança (o `pending` atrasado não reabre venda paga);
 *   - o comprador da loja completa o do gateway, sem sobrescrevê-lo;
 *   - o custo é o que valia na data do pedido, não o de hoje;
 *   - só venda paga vira conversão.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db/index";
import { orderItems, orders } from "../db/schema";
import { resolveAttribution, type ResolvedAttribution } from "./attribution";
import { dispatchOrder } from "./dispatch";
import { ORDER_STATUS_RANK, type CanonicalOrder } from "./types";
import { aplicarCustos } from "./custos";
import { decryptRecord, encryptRecord } from "./crypto";

export interface ContextoPedido {
  tenantId: string;
  /** Conexão de gateway que originou a venda. */
  conexaoId: string;
  /** Id do adaptador — "pagou", "appmax". Usado na busca por reivindicação. */
  gateway: string;
}

export interface ResultadoPedido {
  /** `null` quando o estado recebido é anterior ao que já está gravado. */
  orderId: string | null;
  status: CanonicalOrder["status"];
  atribuicao: ResolvedAttribution;
  disparos: unknown[];
  /** Verdadeiro quando nada mudou porque o estado não avançou. */
  ignorado: boolean;
}

export async function registrarPedido(
  ctx: ContextoPedido,
  entrada: CanonicalOrder,
): Promise<ResultadoPedido> {
  let pedido = entrada;

  const atribuicao = await resolveAttribution(ctx.tenantId, pedido, ctx.gateway);

  /*
   * Completa o comprador com o que a LOJA informou ao reivindicar o pedido.
   *
   * É o único caminho para endereço e nascimento: nenhum dos gateways
   * integrados devolve isso. O dado do gateway prevalece onde os dois têm,
   * porque foi ele que processou o pagamento — o da loja preenche o resto.
   */
  if (atribuicao.compradorDaLoja) {
    try {
      const daLoja = await decryptRecord(atribuicao.compradorDaLoja);
      const g = pedido.customer ?? {};
      pedido = {
        ...pedido,
        customer: {
          name: g.name ?? daLoja.name,
          email: g.email ?? daLoja.email,
          phone: g.phone ?? daLoja.phone,
          document: g.document ?? daLoja.document,
          zip: g.zip ?? daLoja.zip,
          city: g.city ?? daLoja.city,
          state: g.state ?? daLoja.state,
          country: g.country ?? daLoja.country ?? "br",
          birthdate: daLoja.birthdate,
          gender: daLoja.gender,
        },
      };
    } catch { /* comprador ilegível: segue com o que o gateway deu */ }
  }

  const [existente] = await db
    .select()
    .from(orders)
    .where(and(
      eq(orders.gatewayConnectionId, ctx.conexaoId),
      eq(orders.gatewayOrderId, pedido.gatewayOrderId),
    ))
    .limit(1);

  /*
   * Estado só avança. Gateways não garantem ordem de entrega, e um `pending`
   * atrasado chegando depois do `paid` reabriria uma venda já concluída — o
   * faturamento do dia despencaria sozinho.
   *
   * É também o que faz a reconciliação ser segura de rodar quantas vezes for:
   * venda que já entrou pelo webhook para aqui, sem novo disparo.
   */
  if (existente && ORDER_STATUS_RANK[pedido.status] <= ORDER_STATUS_RANK[existente.status]) {
    return {
      orderId: existente.id, status: pedido.status,
      atribuicao, disparos: [], ignorado: true,
    };
  }

  /*
   * Cifra o comprador antes de gravar.
   *
   * O schema sempre disse "cifrado em repouso" e não estava: nome, e-mail,
   * telefone, CPF, endereço e nascimento iam em claro para o jsonb. Um dump do
   * banco, ou uma DATABASE_URL vazada, entregaria o cadastro inteiro de todos
   * os compradores — e CPF em claro é o pior item dessa lista.
   *
   * Não custa nada em qualidade de evento: o disparo usa o comprador que está
   * em memória, vindo do webhook, e não relê esta coluna. O que se grava aqui
   * serve para conferência e reprocessamento, não para o CAPI.
   */
  const comprador = pedido.customer
    ? await encryptRecord(
        Object.fromEntries(
          Object.entries(pedido.customer).filter(
            (e): e is [string, string] => typeof e[1] === "string" && e[1] !== "",
          ),
        ),
      )
    : undefined;

  const comum = {
    status: pedido.status,
    currency: pedido.currency,
    grossCents: pedido.grossCents,
    feeCents: pedido.feeCents ?? null,
    shippingCents: pedido.shippingCents ?? null,
    discountCents: pedido.discountCents ?? null,
    paymentMethod: pedido.paymentMethod,
    installments: pedido.installments ?? null,
    customer: comprador,
    clickId: atribuicao.clickId ?? null,
    attributionMethod: atribuicao.method,
    occurredAt: pedido.occurredAt,
    paidAt: pedido.status === "paid" ? pedido.occurredAt : null,
    updatedAt: new Date(),
  };

  let orderRowId: string;

  if (existente) {
    await db.update(orders).set(comum).where(eq(orders.id, existente.id));
    orderRowId = existente.id;
  } else {
    const [nova] = await db.insert(orders).values({
      tenantId: ctx.tenantId,
      gatewayConnectionId: ctx.conexaoId,
      gatewayOrderId: pedido.gatewayOrderId,
      ...comum,
    }).returning({ id: orders.id });

    orderRowId = nova!.id;

    if (pedido.items.length) {
      await db.insert(orderItems).values(pedido.items.map((i) => ({
        orderId: orderRowId,
        tenantId: ctx.tenantId,
        sku: i.sku ?? null,
        name: i.name,
        quantity: i.quantity,
        unitPriceCents: i.unitPriceCents,
        unitCostCents: i.unitCostCents ?? null,
        variant: i.variant ?? null,
        category: i.category ?? null,
      })));
    }
  }

  /*
   * Aplica o custo dos produtos, com o preço que valia na data do pedido. Sem
   * isto o "lucro" seria margem sobre o anúncio — o que some quando chega a
   * nota do fornecedor.
   */
  await aplicarCustos(ctx.tenantId, orderRowId, pedido.occurredAt);

  /* Só venda paga vira conversão. Pendente ainda pode não acontecer. */
  const disparos = pedido.status === "paid"
    ? await dispatchOrder(ctx.tenantId, orderRowId, pedido, atribuicao)
    : [];

  return { orderId: orderRowId, status: pedido.status, atribuicao, disparos, ignorado: false };
}
