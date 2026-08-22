/*
 * O leque de envio: uma venda entra, N plataformas recebem.
 *
 * A garantia que importa aqui é não mandar a mesma conversão duas vezes. O
 * gateway reentrega webhook por desenho — se a resposta demorar, ele tenta de
 * novo — e cada reentrega chegaria aqui pedindo o mesmo disparo. Duplicar
 * conversão infla o ROAS na plataforma e faz o algoritmo otimizar em cima de
 * um número que não existe.
 *
 * A defesa não é uma trava em memória, que não sobrevive entre funções
 * serverless: é um índice único em (destino, event_id, evento). A segunda
 * tentativa colide no banco e para ali.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db/index";
import { destinations, dispatches, orderItems, orders } from "../db/schema";
import { getDestination } from "../destinations/registry";
import type { ConversionEvent, DispatchInput } from "../destinations/types";
import { decryptRecord } from "./crypto";
import { mergeClickContext, type ResolvedAttribution } from "./attribution";
import type { CanonicalOrder } from "./types";

export interface DispatchSummary {
  destination: string;
  status: "sent" | "failed" | "skipped";
  matchKeys?: string[];
  error?: string;
}

/**
 * Dispara uma venda para todos os destinos ativos da loja.
 *
 * `order` é o pedido canônico recém-processado; `orderRowId` é a linha já
 * gravada, usada para amarrar os disparos à venda no banco.
 */
export async function dispatchOrder(
  tenantId: string,
  orderRowId: string,
  order: CanonicalOrder,
  resolved: ResolvedAttribution,
  event: ConversionEvent = "purchase",
): Promise<DispatchSummary[]> {
  const alvos = await db
    .select()
    .from(destinations)
    .where(and(eq(destinations.tenantId, tenantId), eq(destinations.active, true)));

  if (alvos.length === 0) return [];

  const click = mergeClickContext(resolved, order);

  const input: DispatchInput = {
    event,
    /*
     * O event_id é o id da venda no gateway, não um valor novo. Assim, se um
     * dia voltar a existir pixel no navegador, os dois lados chegam ao mesmo
     * identificador sem precisar combinar nada — que é exatamente o que a
     * deduplicação da Meta espera.
     */
    eventId: order.gatewayOrderId,
    occurredAt: order.occurredAt,
    order,
    click,
    sourceUrl: click.landingUrl,
    valueCents: order.grossCents,
    currency: order.currency,
  };

  const resultados: DispatchSummary[] = [];

  for (const alvo of alvos) {
    const adapter = getDestination(alvo.platform);
    if (!adapter || !adapter.supports.includes(event)) {
      resultados.push({ destination: alvo.label, status: "skipped" });
      continue;
    }

    /*
     * Reserva o disparo antes de executá-lo. Se outra entrega do mesmo webhook
     * estiver correndo em paralelo, uma das duas colide aqui e desiste — sem
     * precisar de trava distribuída.
     */
    const reserva = await db
      .insert(dispatches)
      .values({
        tenantId,
        destinationId: alvo.id,
        orderId: orderRowId,
        eventName: event,
        eventId: input.eventId,
        status: "pending",
        attempts: 1,
      })
      .onConflictDoNothing()
      .returning({ id: dispatches.id });

    const linha = reserva[0];
    if (!linha) {
      resultados.push({ destination: alvo.label, status: "skipped" });
      continue;
    }

    let credenciais: Record<string, string>;
    try {
      credenciais = await decryptRecord(alvo.credentials);
    } catch (e) {
      await db.update(dispatches)
        .set({ status: "failed", error: "credencial ilegível", sentAt: new Date() })
        .where(eq(dispatches.id, linha.id));
      resultados.push({ destination: alvo.label, status: "failed", error: "credencial ilegível" });
      continue;
    }

    const r = await adapter.send(input, {
      externalId: alvo.externalId,
      credentials: credenciais,
      testEventCode: alvo.testEventCode,
      config: alvo.config,
    });

    await db.update(dispatches)
      .set({
        status: r.ok ? "sent" : "failed",
        matchKeyCount: r.matchKeys.length,
        matchKeys: r.matchKeys,
        requestBody: r.requestBody ?? null,
        responseBody: r.responseBody ?? null,
        error: r.error ?? null,
        sentAt: new Date(),
      })
      .where(eq(dispatches.id, linha.id));

    resultados.push({
      destination: alvo.label,
      status: r.ok ? "sent" : "failed",
      matchKeys: r.matchKeys,
      error: r.error,
    });
  }

  return resultados;
}

/**
 * Soma o custo dos itens de uma venda, para o lucro.
 * Devolve `null` quando nenhum item tem custo — zero seria mentira, e um lucro
 * calculado sobre custo zero é pior que lucro nenhum.
 */
export async function computeCogs(orderRowId: string): Promise<number | null> {
  const itens = await db.select().from(orderItems).where(eq(orderItems.orderId, orderRowId));
  const comCusto = itens.filter((i) => i.unitCostCents !== null);
  if (comCusto.length === 0) return null;
  return comCusto.reduce((s, i) => s + (i.unitCostCents ?? 0) * i.quantity, 0);
}

/** Carrega uma venda pelo id, para reprocessamento. */
export async function loadOrder(orderRowId: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, orderRowId)).limit(1);
  return row ?? null;
}
