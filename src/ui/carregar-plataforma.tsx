import { and, eq } from "drizzle-orm";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { db } from "@/db/index";
import { adAccounts } from "@/db/schema";
import { contexto } from "@/core/sessao";
import { lojaAtual } from "@/core/loja-atual";
import { metricas, totalizar, type Nivel } from "@/core/metricas";
import { sincronizarGasto } from "@/core/sincronizar-gasto";
import { Plataforma } from "./plataforma";

/*
 * Carrega uma tela de plataforma. As cinco compartilham isto porque a
 * diferença entre elas é o rótulo e o identificador — a consulta é a mesma.
 */

const NIVEIS = ["conta", "campanha", "conjunto", "anuncio"] as const;

/** Converte o período escolhido em datas, no fuso da loja. */
function janela(periodo: string, timezone: string): { de: string; ate: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
  const hoje = fmt.format(new Date());
  const dias = periodo === "hoje" ? 0
    : periodo === "14d" ? 13
    : periodo === "30d" ? 29 : 6;
  const de = fmt.format(new Date(Date.now() - dias * 86400_000));
  return { de, ate: hoje };
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
  const periodo = um(busca.periodo) || "7d";
  const nome = um(busca.nome);

  const { de, ate } = janela(periodo, loja.timezone);

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
  const OBSOLETO_MIN = 10;
  const velha = contas.find((c) =>
    !c.sincronizadoEm || Date.now() - c.sincronizadoEm.getTime() > OBSOLETO_MIN * 60_000);

  if (velha) {
    after(async () => {
      try {
        await sincronizarGasto(loja.id, { plataforma, dias: 7 });
      } catch { /* falha de sincronização não pode derrubar a tela */ }
    });
  }

  const linhas = contas.length
    ? await metricas({ tenantId: loja.id, plataforma, de, ate, nivel, nome })
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
