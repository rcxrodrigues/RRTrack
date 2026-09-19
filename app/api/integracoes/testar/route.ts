/*
 * "Testar conexão": pergunta à plataforma se a credencial cadastrada vale.
 *
 * Existe porque cadastrar credencial errada NÃO dá erro. A tela salva, a linha
 * fica no banco, e a descoberta acontece dias depois — quando alguém compara o
 * número da plataforma com o nosso e não bate. Entre o cadastro e a descoberta,
 * conversão foi perdida e ninguém tinha como saber.
 *
 * É também o que torna seguro trocar a versão da API em `core/versoes.ts`: a
 * versão viaja na URL, então uma versão que a plataforma não reconhece mais
 * falha aqui, na hora, com a mensagem dela — em vez de falhar no próximo
 * disparo real, em silêncio.
 *
 * DUAS COISAS DIFERENTES são testadas por esta rota, e é de propósito:
 *
 *   `pixel`         — o token do destino de conversão (Conversions API).
 *   `conta_anuncio` — o token que busca gasto (Marketing API).
 *
 * Na Meta os dois podem ser tokens distintos, com permissões distintas, e é
 * comum um valer e o outro não. Um botão só que testasse "a Meta" esconderia
 * exatamente a metade que está quebrada.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { adAccounts, destinations } from "@/db/schema";
import { exigirSessao } from "@/core/sessao";
import { acessoALoja } from "@/core/auth";
import { decryptRecord } from "@/core/crypto";
import { getDestination } from "@/destinations/registry";
import { getAdSpend } from "@/ads/registry";

export const runtime = "nodejs";

function texto(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** AAAA-MM-DD de ontem, em UTC. */
function ontem(): string {
  const d = new Date(Date.now() - 86_400_000);
  return d.toISOString().slice(0, 10);
}

export async function POST(req: Request): Promise<Response> {
  const sessao = await exigirSessao();
  if (!sessao.ok) return sessao.resposta;

  const corpo = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const tenantId = texto(corpo.tenantId);
  const tipo = texto(corpo.tipo);
  const id = texto(corpo.id);

  if (!tenantId || !id) {
    return Response.json({ erro: "loja e id são obrigatórios" }, { status: 400 });
  }

  /* Mesma trava da rota que grava: quem diz a loja é o pedido, quem confirma
     é o banco. Sem isto, trocar o id no corpo testaria — e portanto revelaria
     o estado de — integração de outra conta. */
  const loja = await acessoALoja(sessao.ctx.usuario.userId, tenantId);
  if (!loja) return Response.json({ erro: "não encontrado" }, { status: 404 });

  /* ------------------------------------------------------------- pixel -- */
  if (tipo === "pixel") {
    const [destino] = await db.select().from(destinations)
      .where(and(eq(destinations.id, id), eq(destinations.tenantId, tenantId)))
      .limit(1);
    if (!destino) return Response.json({ erro: "não encontrado" }, { status: 404 });

    const adaptador = getDestination(destino.platform);
    if (!adaptador?.testar) {
      return Response.json({
        ok: false,
        detalhe: `${destino.platform} ainda não sabe se testar`,
      });
    }

    const credenciais = await decryptRecord(destino.credentials);
    const r = await adaptador.testar({
      externalId: destino.externalId,
      credentials: credenciais,
      testEventCode: destino.testEventCode,
      config: destino.config,
    });

    return Response.json({ ok: r.ok, detalhe: r.detalhe });
  }

  /* ---------------------------------------------------- conta de anúncio -- */
  if (tipo === "conta_anuncio") {
    const [conta] = await db.select().from(adAccounts)
      .where(and(eq(adAccounts.id, id), eq(adAccounts.tenantId, tenantId)))
      .limit(1);
    if (!conta) return Response.json({ erro: "não encontrado" }, { status: 404 });

    const adaptador = getAdSpend(conta.platform);
    if (!adaptador) {
      return Response.json({ ok: false, detalhe: `plataforma ${conta.platform} desconhecida` });
    }

    /*
     * Respeita o bloqueio antes de qualquer coisa.
     *
     * A Meta avisa que insistir durante bloqueio AUMENTA a espera. Um botão de
     * teste que ignorasse isso transformaria "só conferir" em piorar a situação
     * — e o instinto de quem vê erro é justamente clicar de novo.
     */
    if (conta.blockedUntil && conta.blockedUntil > new Date()) {
      const min = Math.ceil((conta.blockedUntil.getTime() - Date.now()) / 60_000);
      return Response.json({
        ok: false,
        detalhe: `plataforma bloqueou esta conta; libera em ~${min} min. Não insista antes disso.`,
      });
    }

    /*
     * O teste é uma busca de gasto de UM dia.
     *
     * De propósito: é exatamente o caminho que a sincronização usa, então ele
     * confere de uma vez a versão na URL, o token, o acesso àquela conta e a
     * moeda em que ela reporta. Um teste que chamasse outro endpoint poderia
     * passar enquanto o caminho real falha.
     *
     * Ontem, e não hoje: hoje de manhã vem vazio e vazio não distingue "deu
     * certo e não teve gasto" de "deu errado calado".
     */
    const dia = ontem();

    try {
      const credenciais = await decryptRecord(conta.credentials);
      const r = await adaptador.buscarGasto(conta.externalId, credenciais, { de: dia, ate: dia });

      const partes = [`moeda ${r.moeda}`, `${r.linhas.length} linha(s) em ${dia}`];
      if (r.usoPct != null) partes.push(`cota em ${Math.round(r.usoPct)}%`);
      const avisos = r.avisos.length ? ` — ${r.avisos.join("; ")}` : "";

      return Response.json({ ok: true, detalhe: partes.join(", ") + avisos });
    } catch (e) {
      return Response.json({
        ok: false,
        detalhe: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return Response.json({ erro: "tipo inválido" }, { status: 400 });
}
