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

/* ================================================ eventos de navegação == */

/*
 * O site fala GA4, o sistema fala canônico, a Meta fala outro dialeto ainda.
 * Aceitamos os dois nomes de entrada porque quem instala o snippet vem quase
 * sempre de um GTM com esquema de e-commerce do GA4 e escreveria `view_item`
 * por reflexo. Recusar por causa do nome seria perder o evento por nada.
 */
const NOMES: Record<string, ConversionEvent> = {
  page_view: "page_view",
  pageview: "page_view",

  view_item: "view_content",
  view_content: "view_content",
  product_view: "view_content",

  add_to_cart: "add_to_cart",
  view_cart: "add_to_cart",

  begin_checkout: "initiate_checkout",
  initiate_checkout: "initiate_checkout",
  open_cart: "initiate_checkout",

  add_payment_info: "add_payment_info",
  lead: "lead",
  subscribe: "subscribe",
  purchase: "purchase",
};

export function normalizarEvento(nome: string): ConversionEvent | null {
  return NOMES[nome.trim().toLowerCase()] ?? null;
}

/*
 * Eventos que um destino recebe quando ninguém configurou nada.
 *
 * `page_view` fica de fora do padrão de propósito. É o evento de maior volume
 * de todos — uma chamada à Meta por página vista de cada visitante — e o de
 * menor valor de otimização: ele não diz nada sobre intenção. Quem quiser
 * ligar, liga na configuração do destino; o custo é consciente.
 */
const PADRAO: ConversionEvent[] = [
  "view_content", "add_to_cart", "initiate_checkout", "add_payment_info",
  "purchase", "lead", "subscribe",
];

export interface EntradaNavegacao {
  tenantId: string;
  evento: ConversionEvent;
  eventId: string;
  occurredAt: Date;
  pageUrl?: string;
  valueCents?: number;
  currency?: string;
  contents?: Array<{ id: string; quantity?: number; priceCents?: number; name?: string }>;
  click: Record<string, string | undefined>;
}

/**
 * Manda um evento de navegação para as plataformas.
 *
 * A diferença para uma venda não é técnica, é de informação: aqui não há
 * comprador. Quem está navegando ainda não disse quem é, então só existem as
 * chaves de navegador — fbp, fbc, ip, user-agent e o identificador de sessão.
 * Cinco chaves é o teto natural do meio do funil, e está tudo bem: o EMQ que
 * a Meta publica é dominado pelo `Purchase`, e é lá que as chaves de pessoa
 * entram, vindas do webhook.
 *
 * O que estes eventos fazem por você é outra coisa: dão ao algoritmo o sinal
 * intermediário para otimizar, e alimentam público de remarketing.
 */
export async function dispatchBrowserEvent(e: EntradaNavegacao): Promise<DispatchSummary[]> {
  const alvos = await db
    .select()
    .from(destinations)
    .where(and(eq(destinations.tenantId, e.tenantId), eq(destinations.active, true)));

  if (alvos.length === 0) return [];

  const input: DispatchInput = {
    event: e.evento,
    /* O mesmo id que o navegador gerou — é o que deduplica se houver pixel. */
    eventId: e.eventId,
    occurredAt: e.occurredAt,
    click: e.click,
    sourceUrl: e.pageUrl,
    valueCents: e.valueCents,
    currency: e.currency,
    contents: e.contents,
  };

  const resultados: DispatchSummary[] = [];

  for (const alvo of alvos) {
    const adapter = getDestination(alvo.platform);
    if (!adapter || !adapter.supports.includes(e.evento)) {
      resultados.push({ destination: alvo.label, status: "skipped" });
      continue;
    }

    const permitidos = Array.isArray(alvo.config?.eventos)
      ? (alvo.config.eventos as ConversionEvent[])
      : PADRAO;

    if (!permitidos.includes(e.evento)) {
      resultados.push({ destination: alvo.label, status: "skipped" });
      continue;
    }

    const reserva = await db
      .insert(dispatches)
      .values({
        tenantId: e.tenantId,
        destinationId: alvo.id,
        orderId: null,
        eventName: e.evento,
        eventId: e.eventId,
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
    } catch {
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
