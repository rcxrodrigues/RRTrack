/*
 * Confere se o subdomínio do coletor está de pé, e só então libera o snippet
 * a usá-lo.
 *
 * O PROBLEMA QUE ISTO EVITA. `sites.collector_host` é preenchido sozinho no
 * cadastro da loja, como palpite ("t." + domínio), muito antes de existir
 * registro de DNS. Se o snippet passasse a apontar para esse palpite na hora,
 * quem copiasse o código novo antes de configurar o DNS não teria coleta pior:
 * não teria coleta NENHUMA. O navegador não resolve o host, nenhum evento sai,
 * e o painel continua verde — porque do lado de cá nada dá erro quando nada
 * chega. É o tipo de quebra que só aparece no fim do mês, no faturamento.
 *
 * Por isso a migração é em duas etapas: o subdomínio existe no banco desde
 * sempre, mas o snippet só migra depois que ESTA rota buscou
 * `https://<coletor>/rr.js` e recebeu o script de volta.
 *
 * Confere as DUAS pontas, e não só o script: um CDN ou um proxy mal apontado
 * serve o arquivo estático e não roteia a API. Nesse caso o snippet carregaria
 * lindamente e todo evento morreria no POST — que é pior que não migrar, e
 * invisível do lado de cá.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { sites } from "@/db/schema";
import { exigirSessao } from "@/core/sessao";
import { acessoALoja } from "@/core/auth";

export const runtime = "nodejs";

function texto(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/*
 * A mesma lista de public/rr.js e de app/api/collect/route.ts. Ver o comentário
 * de lá sobre por que a duplicata existe e o que a vigia.
 */
const COMPOSTOS = new Set([
  "com.br", "net.br", "org.br", "com.pt",
  "co.uk", "org.uk", "me.uk", "ac.uk",
  "com.au", "net.au", "org.au",
  "co.jp", "co.nz", "co.za", "co.in", "com.mx", "com.ar", "com.co",
]);

function dominioRegistravel(host: string): string {
  const partes = host.toLowerCase().split(".");
  if (partes.length <= 2) return partes.join(".");
  const dois = partes.slice(-2).join(".");
  return COMPOSTOS.has(dois) ? partes.slice(-3).join(".") : dois;
}

/** Limpa o que a pessoa digitou: aceita URL colada, devolve hostname. */
function normalizarHost(bruto: string): string | null {
  const limpo = bruto.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!limpo || !/^[a-z0-9.-]+$/.test(limpo) || !limpo.includes(".")) return null;
  return limpo;
}

export async function POST(req: Request): Promise<Response> {
  const sessao = await exigirSessao();
  if (!sessao.ok) return sessao.resposta;

  const corpo = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const tenantId = texto(corpo.tenantId);
  if (!tenantId) return Response.json({ erro: "loja não informada" }, { status: 400 });

  const loja = await acessoALoja(sessao.ctx.usuario.userId, tenantId);
  if (!loja) return Response.json({ erro: "não encontrado" }, { status: 404 });

  const [site] = await db.select().from(sites)
    .where(and(eq(sites.tenantId, tenantId), eq(sites.active, true))).limit(1);
  if (!site) return Response.json({ erro: "site não cadastrado" }, { status: 404 });

  /*
   * Trocar o subdomínio é permitido, mas só DENTRO do domínio do site.
   *
   * Sem esta amarra, quem tivesse acesso ao painel poderia apontar o coletor
   * para um host qualquer — e aí o snippet da loja passaria a carregar
   * JavaScript de terceiro no site dela, assinado pela nossa tela de
   * configuração. O domínio do site vem do banco; o host proposto é conferido
   * contra ele.
   */
  let host = site.collectorHost;
  const proposto = texto(corpo.host);
  if (proposto) {
    const limpo = normalizarHost(proposto);
    if (!limpo) return Response.json({ erro: "endereço inválido" }, { status: 400 });
    if (dominioRegistravel(limpo) !== dominioRegistravel(site.domain)) {
      return Response.json({
        erro: `o coletor tem de ser um subdomínio de ${dominioRegistravel(site.domain)}`,
      }, { status: 400 });
    }
    host = limpo;
  }

  if (!host) return Response.json({ erro: "nenhum subdomínio definido" }, { status: 400 });

  /* ------------------------------------------------------ as duas provas -- */

  const falhar = async (motivo: string) => {
    /*
     * Falha ZERA a verificação, e isso é o principal: se o DNS caiu depois de
     * ter funcionado, o snippet precisa voltar sozinho para o domínio do
     * RRTrack. Deixar a data antiga de pé manteria a loja apontando para um
     * host morto até alguém reparar.
     */
    await db.update(sites)
      .set({ collectorHost: host, collectorVerifiedAt: null })
      .where(eq(sites.id, site.id));
    return Response.json({ ok: false, host, detalhe: motivo });
  };

  let resposta: Response;
  try {
    resposta = await fetch(`https://${host}/rr.js`, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    /* DNS inexistente, certificado inválido e host mudo caem todos aqui, e a
       mensagem do fetch é o que distingue os três para quem for corrigir. */
    return falhar(`não respondeu: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!resposta.ok) return falhar(`respondeu HTTP ${resposta.status} em /rr.js`);

  const script = await resposta.text().catch(() => "");
  /*
   * Confere que é O NOSSO script, e não a página de "domínio não configurado"
   * que provedor nenhum devolve com erro — a maioria manda 200 com HTML.
   */
  if (!script.includes("RRTrackConfig")) {
    return falhar("respondeu, mas não com o rr.js — confira para onde o DNS aponta");
  }

  /*
   * A segunda ponta. Um CDN mal apontado serve o arquivo estático e não roteia
   * a API: o snippet carregaria e todo evento morreria no POST, em silêncio.
   */
  try {
    const pre = await fetch(`https://${host}/rr/collect`, {
      method: "OPTIONS",
      headers: { origin: `https://${site.domain}`, "access-control-request-method": "POST" },
      signal: AbortSignal.timeout(8000),
    });
    if (!pre.ok) return falhar(`o script carrega, mas /rr/collect devolveu HTTP ${pre.status}`);
    if (!pre.headers.get("access-control-allow-origin")) {
      return falhar("/rr/collect respondeu sem cabeçalho de CORS — não é o RRTrack");
    }
  } catch (e) {
    return falhar(`/rr/collect não respondeu: ${e instanceof Error ? e.message : String(e)}`);
  }

  const agora = new Date();
  await db.update(sites)
    .set({ collectorHost: host, collectorVerifiedAt: agora })
    .where(eq(sites.id, site.id));

  return Response.json({
    ok: true,
    host,
    verificadoEm: agora.toISOString(),
    detalhe: "o script e o coletor respondem; o snippet já pode usar este endereço",
  });
}
