/*
 * Roteador de webhook, um endereço por conexão de gateway.
 *
 *   /api/webhook/pagou/<segredo>
 *
 * O segredo no caminho não é enfeite: é a única barreira contra venda forjada
 * em gateway que não assina o payload. Quem tiver o endereço consegue inserir
 * uma venda — e, pior, disparar uma conversão falsa que a Meta vai usar para
 * otimizar. Por isso ele é longo, aleatório e por conexão, nunca global.
 */

import { after } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import {
  gatewayConnections, orderItems, orders, webhookDeliveries,
} from "@/db/schema";
import { getGateway } from "@/gateways/registry";
import { resolveAttribution } from "@/core/attribution";
import { dispatchOrder, reenviarPendentes } from "@/core/dispatch";
import { ORDER_STATUS_RANK } from "@/core/types";
import { aplicarCustos } from "@/core/custos";
import { decryptRecord } from "@/core/crypto";

export const runtime = "nodejs";

type Params = { params: Promise<{ gateway: string; secret: string }> };

export async function POST(req: Request, { params }: Params): Promise<Response> {
  const { gateway, secret } = await params;

  const adapter = getGateway(gateway);
  if (!adapter) return Response.json({ erro: "gateway desconhecido" }, { status: 404 });

  const [conexao] = await db
    .select()
    .from(gatewayConnections)
    .where(and(
      eq(gatewayConnections.gateway, gateway),
      eq(gatewayConnections.webhookSecret, secret),
      eq(gatewayConnections.active, true),
    ))
    .limit(1);

  /* Segredo errado e conexão inexistente devolvem a mesma coisa, de propósito:
     um 404 que diferenciasse os dois casos viraria um oráculo de segredos. */
  if (!conexao) return Response.json({ erro: "não encontrado" }, { status: 404 });

  const rawBody = await req.text();
  const cabecalhos: Record<string, string> = {};
  req.headers.forEach((v, k) => { cabecalhos[k] = v; });

  const verificacao = await adapter.verify({ headers: cabecalhos, rawBody, query: {} }, secret);

  /*
   * `sem_assinatura` não é falha: é a constatação de que o gateway não oferece
   * como provar a origem. O segredo do caminho já foi conferido, e a venda
   * entra marcada como não verificada — o que permite ao painel separar o que
   * está provado do que está apenas plausível.
   *
   * Qualquer outro motivo é assinatura inválida de verdade, e aí é rejeição.
   */
  const semAssinatura = !verificacao.ok && verificacao.reason === "sem_assinatura";
  if (!verificacao.ok && !semAssinatura) {
    return Response.json({ erro: "assinatura inválida" }, { status: 401 });
  }

  let pedido;
  try {
    pedido = await adapter.parse({ headers: cabecalhos, rawBody, query: {} });
  } catch (e) {
    return Response.json(
      { erro: "payload ilegível", detalhe: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }

  /* Evento que não representa estado de venda — teste de conexão, payout. */
  if (!pedido) return Response.json({ ok: true, ignorado: true });

  const temCredencial = Object.keys(conexao.credentials).length > 0;
  let confirmado = verificacao.ok;

  /*
   * Confirmação pela API, para gateway que não assina o webhook.
   *
   * Sem assinatura, a mensagem sozinha não prova nada: quem descobrir a URL
   * injeta uma venda que nunca houve. E o estrago não é o painel mentir — é a
   * conversão falsa chegar na Meta e ela passar a otimizar para um comprador
   * que não existe.
   *
   * A distinção que rege o que fazer: CONTRADIÇÃO é fraude, ERRO é
   * desconhecido. Se a API diz que o pedido não existe, ou diz outro valor,
   * recusamos. Se a API está fora do ar, seguimos sem confirmar — derrubar
   * venda de verdade por causa de instabilidade alheia seria pior que o risco
   * que se está evitando.
   */
  if (semAssinatura && temCredencial && adapter.fetchOrder) {
    let cred: Record<string, string> | null = null;
    try {
      cred = await decryptRecord(conexao.credentials);
    } catch { /* credencial ilegível: segue sem confirmar */ }

    if (cred) {
      try {
        const daApi = await adapter.fetchOrder(pedido.gatewayOrderId, cred);

        if (!daApi) {
          return Response.json(
            { erro: "pedido não existe no gateway" },
            { status: 403 },
          );
        }

        if (daApi.grossCents !== pedido.grossCents) {
          return Response.json({
            erro: "valor do webhook não confere com o gateway",
            recebido: pedido.grossCents,
            real: daApi.grossCents,
          }, { status: 403 });
        }

        /*
         * O estado da API é mais atual que o do webhook, que pode ter ficado
         * na fila. Uma venda já estornada não deve entrar como paga só porque
         * a notificação de pagamento chegou atrasada.
         */
        pedido = { ...pedido, status: daApi.status, customer: pedido.customer ?? daApi.customer };
        confirmado = true;
      } catch {
        /* API instável: segue como não confirmado, sem recusar. */
      }
    }
  }

  /*
   * Completa o que o webhook não trouxe. A Appmax não manda comprador nenhum
   * no webhook de pedido, então sem isto a venda dela chegaria só com as
   * chaves de navegador. Melhor-esforço: falhar aqui não derruba a venda.
   */
  if (adapter.enrich && temCredencial && !pedido.customer) {
    try {
      const cred = await decryptRecord(conexao.credentials);
      pedido = await adapter.enrich(pedido, cred);
    } catch { /* segue com o que o webhook trouxe */ }
  }

  /*
   * Registra a entrega antes de processar. O índice único em
   * (conexão, gatewayEventId) faz a reentrega colidir aqui e sair sem efeito —
   * é o que garante que um webhook repetido não vire venda repetida.
   */
  const entrega = await db.insert(webhookDeliveries).values({
    tenantId: conexao.tenantId,
    gatewayConnectionId: conexao.id,
    gatewayEventId: pedido.gatewayEventId,
    verified: confirmado,
    rawBody,
    headers: cabecalhos,
  }).onConflictDoNothing().returning({ id: webhookDeliveries.id });

  if (!entrega[0]) return Response.json({ ok: true, duplicado: true });

  try {
    const atribuicao = await resolveAttribution(conexao.tenantId, pedido, gateway);

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
        eq(orders.gatewayConnectionId, conexao.id),
        eq(orders.gatewayOrderId, pedido.gatewayOrderId),
      ))
      .limit(1);

    /*
     * Estado só avança. Gateways não garantem ordem de entrega, e um `pending`
     * atrasado chegando depois do `paid` reabriria uma venda já concluída —
     * o faturamento do dia despencaria sozinho.
     */
    if (existente && ORDER_STATUS_RANK[pedido.status] <= ORDER_STATUS_RANK[existente.status]) {
      await db.update(webhookDeliveries)
        .set({ processedAt: new Date() })
        .where(eq(webhookDeliveries.id, entrega[0].id));
      return Response.json({ ok: true, estado_ignorado: pedido.status });
    }

    const comum = {
      status: pedido.status,
      currency: pedido.currency,
      grossCents: pedido.grossCents,
      feeCents: pedido.feeCents ?? null,
      shippingCents: pedido.shippingCents ?? null,
      discountCents: pedido.discountCents ?? null,
      paymentMethod: pedido.paymentMethod,
      installments: pedido.installments ?? null,
      customer: pedido.customer as Record<string, string> | undefined,
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
        tenantId: conexao.tenantId,
        gatewayConnectionId: conexao.id,
        gatewayOrderId: pedido.gatewayOrderId,
        ...comum,
      }).returning({ id: orders.id });

      orderRowId = nova!.id;

      if (pedido.items.length) {
        await db.insert(orderItems).values(pedido.items.map((i) => ({
          orderId: orderRowId,
          tenantId: conexao.tenantId,
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
     * Aplica o custo dos produtos, com o preço que valia na data do pedido.
     * Sem isto o "lucro" seria margem sobre o anúncio — o que some quando
     * chega a nota do fornecedor.
     */
    await aplicarCustos(conexao.tenantId, orderRowId, pedido.occurredAt);

    /* Só venda paga vira conversão. Pendente ainda pode não acontecer. */
    let disparos: unknown[] = [];
    if (pedido.status === "paid") {
      disparos = await dispatchOrder(conexao.tenantId, orderRowId, pedido, atribuicao);
    }

    await db.update(webhookDeliveries)
      .set({ processedAt: new Date() })
      .where(eq(webhookDeliveries.id, entrega[0].id));

    /*
     * A fila de reenvio pega carona aqui, depois da resposta.
     *
     * Não há cron: o plano Hobby da Vercel limita a uma execução por dia, o
     * que é inútil para reenviar conversão. Mas chegou webhook quer dizer que
     * há venda acontecendo, e é exatamente quando vale gastar alguns segundos
     * recuperando o que ficou para trás. Loja parada não paga nada por isso.
     */
    after(async () => {
      try {
        await reenviarPendentes(conexao.tenantId, 10);
      } catch { /* reenvio é melhor-esforço; a venda desta requisição já entrou */ }
    });

    return Response.json({
      ok: true,
      pedido: pedido.gatewayOrderId,
      status: pedido.status,
      atribuicao: atribuicao.method,
      verificado: confirmado,
      disparos,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.update(webhookDeliveries)
      .set({ error: msg })
      .where(eq(webhookDeliveries.id, entrega[0].id));

    /*
     * 500 é deliberado: o gateway reentrega, e a entrega ficou registrada com o
     * erro. Devolver 200 aqui perderia a venda em silêncio, que é o pior
     * desfecho possível.
     */
    return Response.json({ erro: "falha ao processar", detalhe: msg }, { status: 500 });
  }
}
