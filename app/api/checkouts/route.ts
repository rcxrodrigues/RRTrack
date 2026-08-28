/*
 * Cadastro dos checkouts — só para quem está logado.
 *
 * Não confundir com `/api/checkout/pagar`, que é público e cobra. Esta rota
 * configura a oferta; aquela executa. A regra de acesso é diferente e por isso
 * os caminhos também são.
 */

import { exigirSessao } from "@/core/sessao";
import { acessoALoja } from "@/core/auth";
import { excluirCheckout, gravarCheckout, listarCheckouts } from "@/checkout/gestao";
import type { CheckoutEnviado } from "@/checkout/gestao";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const sessao = await exigirSessao();
  if (!sessao.ok) return sessao.resposta;

  const tenantId = new URL(req.url).searchParams.get("tenantId") ?? "";
  if (!tenantId) return Response.json({ erro: "loja não informada" }, { status: 400 });

  const loja = await acessoALoja(sessao.ctx.usuario.userId, tenantId);
  if (!loja) return Response.json({ erro: "não encontrado" }, { status: 404 });

  return Response.json({ checkouts: await listarCheckouts(tenantId) });
}

export async function POST(req: Request): Promise<Response> {
  const sessao = await exigirSessao();
  if (!sessao.ok) return sessao.resposta;

  const corpo = (await req.json().catch(() => ({}))) as
    { tenantId?: string } & CheckoutEnviado;

  const tenantId = corpo.tenantId ?? "";
  if (!tenantId) return Response.json({ erro: "loja não informada" }, { status: 400 });

  const loja = await acessoALoja(sessao.ctx.usuario.userId, tenantId);
  if (!loja) return Response.json({ erro: "não encontrado" }, { status: 404 });

  const r = await gravarCheckout(tenantId, corpo);
  if (!r.ok) return Response.json({ erro: r.erro }, { status: 400 });

  return Response.json({ ok: true, id: r.id, slug: r.slug });
}

export async function DELETE(req: Request): Promise<Response> {
  const sessao = await exigirSessao();
  if (!sessao.ok) return sessao.resposta;

  const url = new URL(req.url);
  const tenantId = url.searchParams.get("tenantId") ?? "";
  const id = url.searchParams.get("id") ?? "";
  if (!tenantId || !id) return Response.json({ erro: "parâmetros faltando" }, { status: 400 });

  const loja = await acessoALoja(sessao.ctx.usuario.userId, tenantId);
  if (!loja) return Response.json({ erro: "não encontrado" }, { status: 404 });

  const apagou = await excluirCheckout(tenantId, id);
  if (!apagou) return Response.json({ erro: "checkout não encontrado" }, { status: 404 });

  return Response.json({ ok: true });
}
