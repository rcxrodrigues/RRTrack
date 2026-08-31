import { and, eq } from "drizzle-orm";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { db } from "@/db/index";
import { adAccounts } from "@/db/schema";
import { contexto } from "@/core/sessao";
import { lojaAtual } from "@/core/loja-atual";
import { metricas, totalizar, type Nivel } from "@/core/metricas";
import { PERIODO_PADRAO, janelaDe } from "@/core/janela";
import { precisaBuscarGasto, sincronizarGasto } from "@/core/sincronizar-gasto";
import { Plataforma } from "./plataforma";

/*
 * Carrega uma tela de plataforma. As cinco compartilham isto porque a
 * diferença entre elas é o rótulo e o identificador — a consulta é a mesma.
 */

const NIVEIS = ["conta", "campanha", "conjunto", "anuncio"] as const;

/*
 * Converte o período em datas, reaproveitando core/janela.ts.
 *
 * Esta função tinha a própria cópia da conta, com os mesmos quatro períodos
 * escritos de novo. Quando "ontem", "esse mês" e "personalizado" entraram na
 * outra, esta ficaria para trás — e a aba de anúncios mostraria uma janela
 * diferente da que o seletor no topo diz, sem nada acusando.
 *
 * `dias` volta junto porque quem busca o gasto na Meta precisa saber o tamanho
 * da janela; agora sai da diferença entre as datas, e não de uma segunda
 * tabela de períodos.
 */
function janela(
  periodo: string, timezone: string, custom?: { de?: string; ate?: string },
): { de: string; ate: string; dias: number } {
  const { de, ate } = janelaDe(periodo, timezone, custom);
  const umDia = 86400_000;
  const dias = Math.max(
    1,
    Math.round((Date.parse(ate + "T12:00:00Z") - Date.parse(de + "T12:00:00Z")) / umDia) + 1,
  );
  return { de, ate, dias };
}

export async function CarregarPlataforma({
  plataforma, titulo, busca,
}: {
  plataforma: string;
  titulo: string;
  busca: Record<string, string | string[] | undefined>;
}) {
  const ctx = await contexto();
  if (!ctx) redirect("/entrar");

  const loja = await lojaAtual(ctx);
  if (!loja) {
    return <div style={{ padding: 40, color: "var(--ink-fraco)" }}>Nenhuma loja cadastrada.</div>;
  }

  const um = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

  const nivel = (NIVEIS.includes(um(busca.nivel) as Nivel) ? um(busca.nivel) : "campanha") as Nivel;
  const periodo = um(busca.periodo) || PERIODO_PADRAO;
  const nome = um(busca.nome);

  const { de, ate, dias } = janela(periodo, loja.timezone, {
    de: um(busca.de), ate: um(busca.ate),
  });

  const contas = await db.select({
    id: adAccounts.id, sincronizadoEm: adAccounts.lastSyncedAt,
  }).from(adAccounts).where(and(
    eq(adAccounts.tenantId, loja.id),
    eq(adAccounts.platform, plataforma),
    eq(adAccounts.active, true),
  ));

  /*
   * Sincronização por obsolescência, e não por relógio.
   *
   * Cron seria o caminho óbvio, mas o plano Hobby da Vercel só permite uma
   * execução por dia — inútil para gasto. E consultar de segundo em segundo
   * estouraria o limite da Meta (600 + 400 por anúncio ativo, por hora) e
   * renderia bloqueio: o painel ficaria SEM dado em vez de com dado atrasado.
   *
   * Então quem dispara é a visita. Abrir a tela com o gasto velho manda buscar
   * em segundo plano, e o resultado aparece na atualização automática seguinte.
   * Não custa nada quando ninguém está olhando, e está sempre fresco quando
   * alguém está — que é exatamente quando importa.
   */
  /*
   * A janela que se busca é a que a pessoa está olhando. A decisão mora em
   * core/sincronizar-gasto.ts, para esta tela e o Resumo não divergirem.
   */
  const buscar = await precisaBuscarGasto(loja.id, { de, dias, plataforma });
  if (buscar) {
    after(async () => {
      try {
        await sincronizarGasto(loja.id, { plataforma, dias: buscar });
      } catch { /* falha de sincronização não pode derrubar a tela */ }
    });
  }

  const linhas = contas.length
    ? await metricas({
        tenantId: loja.id, plataforma, de, ate, nivel, nome,
        timezone: loja.timezone,
        /* Gasto so soma se estiver nesta moeda — ver o Filtro em metricas.ts. */
        moeda: loja.currency,
        /* O que esta loja conta como faturamento — ver core/faturamento.ts. */
        regra: { countShipping: loja.countShipping, countInterest: loja.countInterest },
      })
    : [];

  return (
    <Plataforma
      titulo={titulo}
      plataforma={plataforma}
      tenantId={loja.id}
      linhas={linhas}
      total={totalizar(linhas)}
      nivel={nivel}
      periodo={periodo}
      nome={nome}
      temConta={contas.length > 0}
    />
  );
}
