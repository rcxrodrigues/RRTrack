/*
 * A rotina de retenção, chamada pelo Vercel Cron.
 *
 * Zera o corpo dos registros com mais de catorze dias — ver src/core/retencao.ts
 * para o que sai, o que fica e o que NUNCA pode ser zerado.
 *
 * DUAS PORTAS, e as duas fechadas:
 *
 *   O cron da Vercel manda `Authorization: Bearer <CRON_SECRET>`. Sem
 *   `CRON_SECRET` no ambiente esta porta simplesmente NÃO EXISTE — e isso não é
 *   detalhe. Comparar contra uma variável vazia deixaria "Bearer undefined"
 *   entrar; é o mesmo defeito do `??` que já custou uma versão de API errada
 *   rodando em produção.
 *
 *   E uma sessão do painel, para rodar à mão quando se quiser conferir. Quem
 *   entra no painel já pode apagar loja pelo painel; zerar corpo de log é menos
 *   que isso.
 *
 * GET porque é o que o Vercel Cron usa. Não é idempotente no sentido estrito
 * (ela escreve), mas é repetível sem estrago: rodar duas vezes seguidas faz a
 * segunda não achar nada para fazer.
 */

import { aplicarRetencao, corpoVelhoParado } from "@/core/retencao";
import { textoIgualEmTempoConstante } from "@/core/auth";
import { contexto } from "@/core/sessao";

export const runtime = "nodejs";
/* Escreve no banco a cada chamada: resposta guardada em cache seria mentira. */
export const dynamic = "force-dynamic";

function autorizado(req: Request): boolean {
  const segredo = process.env.CRON_SECRET?.trim();
  if (!segredo) return false;

  const cabecalho = req.headers.get("authorization") ?? "";
  if (!cabecalho.startsWith("Bearer ")) return false;

  return textoIgualEmTempoConstante(cabecalho.slice(7), segredo);
}

export async function GET(req: Request): Promise<Response> {
  if (!autorizado(req) && !(await contexto())) {
    /*
     * A mensagem diz o que falta, e pode: quem chegou aqui sem credencial não
     * aprende nada com ela, e quem configurou o cron errado passaria horas sem
     * essa linha. Um 401 mudo é indistinguível de "a rota não existe".
     */
    return Response.json({
      erro: "não autorizado",
      detalhe: process.env.CRON_SECRET?.trim()
        ? "mande Authorization: Bearer <CRON_SECRET>, ou entre no painel"
        : "CRON_SECRET não está definida neste ambiente — enquanto isso, só pelo painel",
    }, { status: 401 });
  }

  const r = await aplicarRetencao();

  /*
   * Quanto sobrou, só quando alguém pede (`?conferir=1`).
   *
   * É a resposta honesta para "a rotina está dando conta?" — mas são duas
   * contagens em tabelas grandes, e pagá-las toda madrugada para produzir um
   * número que ninguém lê seria caro à toa. O cron não pede; quem for
   * investigar, pede.
   */
  const conferir = new URL(req.url).searchParams.get("conferir") === "1";
  const restante = conferir ? await corpoVelhoParado() : undefined;

  /*
   * `truncado` no log, e não só na resposta. A resposta some; o log da Vercel é
   * onde alguém vai olhar se o banco continuar crescendo. Truncado toda noite
   * significa que o acúmulo é maior que uma execução, e aí o lote sobe ou a
   * frequência sobe.
   */
  console.log(`[retencao] ${r.disparos} disparos, ${r.entregas} entregas,`
    + ` ${r.contadores} contadores, ${r.lotes} lotes, ${r.ms}ms`
    + (r.truncado ? " — TRUNCADO, ficou trabalho para a próxima" : "")
    + (restante !== undefined ? ` — ${restante} linha(s) ainda com corpo velho` : ""));

  return Response.json({ ok: true, ...r, ...(restante !== undefined ? { restante } : {}) });
}
