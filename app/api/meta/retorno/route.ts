/*
 * Passo 2 de 3: o Facebook devolve a pessoa aqui.
 *
 * Esta rota não grava nada em `ad_accounts` nem em `destinations` — só troca o
 * código por um token longo e guarda esse token por quinze minutos. Quem
 * decide o que vincular é a tela do passo 3.
 *
 * O motivo de separar: a pessoa pode ter vinte contas de anúncio e querer
 * medir uma. Vincular todas por padrão encheria o painel de contas mortas, e
 * cada uma delas viraria uma chamada de sincronização por hora, para sempre.
 */

import { redirect } from "next/navigation";
import { exigirSessao } from "@/core/sessao";
import { acessoALoja } from "@/core/auth";
import { alongarToken, escoposFaltando, inspecionar, trocarCodigo } from "@/ads/meta-oauth";
import { appDaMeta, conferirEstado, guardarToken, urlDeRetorno } from "@/ads/meta-vinculo";

export const runtime = "nodejs";

/* A tela de escolha mostra o que deu errado; aqui só carregamos o motivo. */
function voltarComErro(motivo: string): never {
  redirect(`/integracoes?meta_erro=${encodeURIComponent(motivo)}`);
}

export async function GET(req: Request): Promise<Response> {
  const sessao = await exigirSessao();
  if (!sessao.ok) return sessao.resposta;

  const params = new URL(req.url).searchParams;

  /*
   * Recusar o consentimento é uma escolha legítima, não um erro do sistema —
   * a Meta manda `error=access_denied` e a pessoa merece voltar a uma tela que
   * diz isso, não a um 500.
   */
  if (params.get("error")) {
    voltarComErro(params.get("error_description") ?? "autorização cancelada");
  }

  const tenantId = await conferirEstado(params.get("state"));
  if (!tenantId) voltarComErro("o pedido não confere — comece de novo");

  const loja = await acessoALoja(sessao.ctx.usuario.userId, tenantId);
  if (!loja) voltarComErro("sem acesso a esta loja");

  const code = params.get("code");
  if (!code) voltarComErro("o Facebook não devolveu o código");

  const app = appDaMeta();
  if (!app) voltarComErro("o app da Meta não está configurado no servidor");

  /*
   * Nenhum `redirect` dentro do try: ele funciona lançando uma exceção que o
   * Next intercepta, e um catch por perto a engole. O sintoma é cruel — a
   * pessoa vê "NEXT_REDIRECT" onde deveria estar o motivo do erro. Então o
   * try só decide, e o desvio acontece depois dele.
   */
  let problema: string | null = null;

  try {
    const longo = await alongarToken(app, await trocarCodigo(app, urlDeRetorno(), code));
    const info = await inspecionar(app, longo);

    /*
     * A tela de consentimento deixa desmarcar permissão. Quem desmarca
     * `ads_management` conclui o vínculo achando que deu certo, e descobre
     * semanas depois que nenhum evento saiu — todo disparo volta 401. Melhor
     * barrar aqui, com o nome do que falta.
     */
    const faltando = escoposFaltando(info.escopos);
    if (faltando.length > 0) {
      problema = `faltou autorizar: ${faltando.join(", ")}`;
    } else {
      await guardarToken({
        token: info.token,
        expiraEm: info.expiraEm ? info.expiraEm.toISOString() : null,
        tenantId,
      });
    }
  } catch (e) {
    problema = e instanceof Error ? e.message : "falha ao falar com a Meta";
  }

  if (problema) voltarComErro(problema);

  redirect(`/integracoes/meta?tenantId=${tenantId}`);
}
