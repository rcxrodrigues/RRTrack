/*
 * Passo 1, em outro navegador: devolve um link para copiar.
 *
 * Quem gerencia vários perfis de anúncio trabalha em navegador antidetect, e o
 * Facebook que precisa autorizar vive lá dentro — não no navegador onde o
 * painel está aberto. Sem este caminho, a única saída seria entrar no painel
 * de dentro do antidetect, o que na prática significa duplicar a sessão do
 * RRTrack em um ambiente que existe para NÃO compartilhar sessão.
 *
 * O link expira em trinta minutos e só serve para entregar um token. O que
 * fazer com o token continua sendo decidido no painel, com sessão.
 */

import { exigirSessao } from "@/core/sessao";
import { acessoALoja } from "@/core/auth";
import { abrirVinculo, appDaMeta, urlDoLink } from "@/ads/meta-vinculo";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const sessao = await exigirSessao();
  if (!sessao.ok) return sessao.resposta;

  const corpo = await req.json().catch(() => ({}));
  const tenantId = typeof corpo.tenantId === "string" ? corpo.tenantId : null;
  if (!tenantId) return Response.json({ erro: "falta a loja" }, { status: 400 });

  const loja = await acessoALoja(sessao.ctx.usuario.userId, tenantId);
  if (!loja) return Response.json({ erro: "não encontrado" }, { status: 404 });

  if (!appDaMeta()) {
    return Response.json(
      { erro: "META_APP_ID e META_APP_SECRET não estão configurados no servidor" },
      { status: 503 },
    );
  }

  const vinculo = await abrirVinculo(tenantId, sessao.ctx.usuario.userId);

  return Response.json({
    url: urlDoLink(vinculo.secret),
    /* A tela mostra o prazo para a pessoa saber que não adianta guardar. */
    validoPorMinutos: 15,
  });
}
