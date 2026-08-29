/*
 * Passo 2: o Facebook devolve a pessoa aqui.
 *
 * Esta rota NÃO exige sessão, e é a única do vínculo que não exige. Ela precisa
 * responder ao navegador antidetect, que nunca entrou no painel. Quem prova
 * legitimidade é o `state`: ele é o segredo de uma linha em `meta_links`, criada
 * há minutos por alguém com sessão, e some depois de usada.
 *
 * O que ela faz é só trocar o código por um token longo e guardar. Não grava
 * conta de anúncio nem pixel — isso continua exigindo sessão no painel, na tela
 * de escolha. É essa separação que faz um link vazado valer pouco: no máximo
 * alguém entrega um token que ninguém vai mandar usar.
 */

import { redirect } from "next/navigation";
import { COOKIE } from "@/core/auth";
import { cookies } from "next/headers";
import { alongarToken, escoposFaltando, inspecionar, perfil, trocarCodigo } from "@/ads/meta-oauth";
import { acharPeloSegredo, appDaMeta, fecharVinculo, salvarPerfil, urlDeRetorno } from "@/ads/meta-vinculo";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const state = params.get("state");

  /*
   * Recusar o consentimento é uma escolha legítima, não um erro do sistema — a
   * Meta manda `error=access_denied`, e a pessoa merece uma tela que diga isso.
   */
  const recusa = params.get("error");
  const code = params.get("code");

  const vinculo = state ? await acharPeloSegredo(state) : null;
  const app = appDaMeta();

  /*
   * Nenhum `redirect` dentro do try: ele funciona lançando uma exceção que o
   * Next intercepta, e um catch por perto a engole. O sintoma é cruel — a
   * pessoa vê "NEXT_REDIRECT" onde deveria estar o motivo. Então o try só
   * decide, e o desvio acontece depois dele.
   */
  let problema: string | null = null;

  if (recusa) problema = params.get("error_description") ?? "autorização cancelada";
  else if (!vinculo) problema = "este pedido expirou — gere um link novo no painel";
  else if (!app) problema = "o app da Meta não está configurado no servidor";
  else if (!code) problema = "o Facebook não devolveu o código";
  else {
    try {
      const longo = await alongarToken(app, await trocarCodigo(app, urlDeRetorno(), code));
      const info = await inspecionar(app, longo);

      /*
       * A tela de consentimento deixa desmarcar permissão. Quem desmarca
       * `ads_management` concluiria o vínculo achando que deu certo e
       * descobriria semanas depois que nenhum evento saiu — todo disparo volta
       * 401. Melhor barrar aqui, com o nome do que falta.
       */
      const faltando = escoposFaltando(info.escopos);
      if (faltando.length > 0) problema = `faltou autorizar: ${faltando.join(", ")}`;
      else {
        /*
         * O token vai para o PERFIL, que fica. O link era só o bilhete para
         * atravessar navegadores, e some agora — deixá-lo vivo manteria uma
         * segunda cópia de um token de 60 dias num lugar que ninguém consulta.
         */
        const quem = await perfil(app, info.token);
        await salvarPerfil(
          vinculo.tenantId,
          quem.id || info.usuarioId,
          quem.nome,
          info.token,
          info.expiraEm,
        );
        await fecharVinculo(vinculo.id);
      }
    } catch (e) {
      problema = e instanceof Error ? e.message : "falha ao falar com a Meta";
    }
  }

  /*
   * Para onde mandar depois depende de onde a pessoa está. Quem tem sessão
   * segue direto para a escolha; quem está no antidetect vê uma página que
   * diz para voltar ao painel — mandá-la para /integracoes só produziria um
   * desvio para a tela de login, que ali não faz sentido nenhum.
   */
  const temSessao = !!(await cookies()).get(COOKIE)?.value;

  if (problema) {
    const motivo = encodeURIComponent(problema);
    redirect(temSessao ? `/integracoes?meta_erro=${motivo}` : `/vincular/meta/pronto?erro=${motivo}`);
  }

  redirect(temSessao ? "/integracoes/meta" : "/vincular/meta/pronto");
}
