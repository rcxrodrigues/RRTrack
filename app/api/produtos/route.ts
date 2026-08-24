/*
 * Cadastro de custo por produto.
 *
 * Gravar um custo NÃO sobrescreve o anterior: cria uma nova versão com data de
 * vigência. É o que mantém o lucro do mês passado igual ao que era quando o mês
 * passado aconteceu, mesmo depois de o fornecedor reajustar.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { productCosts } from "@/db/schema";
import { exigirSessao } from "@/core/sessao";
import { acessoALoja } from "@/core/auth";
import { recalcular } from "@/core/custos";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  const sessao = await exigirSessao();
  if (!sessao.ok) return sessao.resposta;

  const corpo = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const tenantId = typeof corpo.tenantId === "string" ? corpo.tenantId : "";
  const sku = typeof corpo.sku === "string" ? corpo.sku.trim() : "";
  const reais = Number(corpo.custo);

  if (!tenantId || !sku) {
    return Response.json({ erro: "loja e SKU são obrigatórios" }, { status: 400 });
  }
  if (!Number.isFinite(reais) || reais < 0) {
    return Response.json({ erro: "custo inválido" }, { status: 400 });
  }

  const loja = await acessoALoja(sessao.ctx.usuario.userId, tenantId);
  if (!loja) return Response.json({ erro: "não encontrado" }, { status: 404 });

  const custoCents = Math.round(reais * 100);

  /*
   * Vigência a partir de quando o lojista disser, e não sempre de agora.
   *
   * Quem cadastra custo pela primeira vez quase sempre quer que ele valha para
   * o histórico também — senão o lucro dos meses anteriores fica errado para
   * sempre. Por isso o padrão é retroagir, e não começar hoje.
   */
  const desde = typeof corpo.desde === "string" && corpo.desde
    ? new Date(corpo.desde)
    : new Date("2000-01-01");

  if (Number.isNaN(desde.getTime())) {
    return Response.json({ erro: "data de vigência inválida" }, { status: 400 });
  }

  await db.insert(productCosts).values({
    tenantId, sku, unitCostCents: custoCents, effectiveFrom: desde,
  });

  /* Reaplica nas vendas que já existiam, senão só o futuro teria lucro certo. */
  const mexidos = await recalcular(tenantId, sku);

  return Response.json({ ok: true, recalculadas: mexidos });
}

export async function DELETE(req: Request): Promise<Response> {
  const sessao = await exigirSessao();
  if (!sessao.ok) return sessao.resposta;

  const url = new URL(req.url);
  const tenantId = url.searchParams.get("tenantId");
  const sku = url.searchParams.get("sku");
  if (!tenantId || !sku) return Response.json({ erro: "parâmetros faltando" }, { status: 400 });

  const loja = await acessoALoja(sessao.ctx.usuario.userId, tenantId);
  if (!loja) return Response.json({ erro: "não encontrado" }, { status: 404 });

  await db.delete(productCosts)
    .where(and(eq(productCosts.tenantId, tenantId), eq(productCosts.sku, sku)));

  return Response.json({ ok: true });
}
