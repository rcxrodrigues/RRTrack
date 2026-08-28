/*
 * Passo 1, no mesmo navegador: manda a pessoa direto para o Facebook.
 *
 * É uma navegação, não um fetch — o Facebook precisa desenhar a tela de
 * consentimento. Por isso o botão do painel é um link comum.
 *
 * Quem autoriza em outro navegador não passa por aqui: usa /api/meta/link,
 * que devolve a mesma coisa em forma de URL para copiar.
 */

import { redirect } from "next/navigation";
import { exigirSessao } from "@/core/sessao";
import { acessoALoja } from "@/core/auth";
import { urlAutorizacao } from "@/ads/meta-oauth";
import { abrirVinculo, appDaMeta, urlDeRetorno } from "@/ads/meta-vinculo";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const sessao = await exigirSessao();
  if (!sessao.ok) return sessao.resposta;

  const tenantId = new URL(req.url).searchParams.get("tenantId");
  if (!tenantId) return Response.json({ erro: "falta a loja" }, { status: 400 });

  const loja = await acessoALoja(sessao.ctx.usuario.userId, tenantId);
  if (!loja) return Response.json({ erro: "não encontrado" }, { status: 404 });

  const app = appDaMeta();
  if (!app) {
    return Response.json(
      { erro: "META_APP_ID e META_APP_SECRET não estão configurados no servidor" },
      { status: 503 },
    );
  }

  const vinculo = await abrirVinculo(tenantId, sessao.ctx.usuario.userId);
  redirect(urlAutorizacao(app, urlDeRetorno(), vinculo.secret));
}
