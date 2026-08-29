import { and, eq } from "drizzle-orm";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { db } from "@/db/index";
import { adAccounts } from "@/db/schema";
import { contexto } from "@/core/sessao";
import { lojaAtual } from "@/core/loja-atual";
import { janelaDe, um, PERIODO_PADRAO } from "@/core/janela";
import { indicadores, funil, porHorario, porOrigem, porPagamento, porRegiao, porPagina } from "@/core/resumo";
import { aoVivo } from "@/core/aovivo";
import { precisaBuscarGasto, sincronizarGasto } from "@/core/sincronizar-gasto";
import { Resumo } from "@/ui/resumo";

export const dynamic = "force-dynamic";

export default async function Pagina({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await contexto();
  if (!ctx) redirect("/entrar");
  const loja = await lojaAtual(ctx);
  if (!loja) return <div style={{ padding: 40, color: "var(--ink-fraco)" }}>Nenhuma loja cadastrada.</div>;

  const busca = await searchParams;
  const periodo = um(busca.periodo) || PERIODO_PADRAO;
  const { de, ate } = janelaDe(periodo, loja.timezone);
  /* O que esta loja conta como faturamento — ver core/faturamento.ts. */
  const regra = { countShipping: loja.countShipping, countInterest: loja.countInterest };
  const p = { tenantId: loja.id, de, ate, timezone: loja.timezone,
    /* So entra no gasto o que estiver nesta moeda — ver core/resumo.ts. */
    moeda: loja.currency, regra };

  const [ind, fun, hor, ori, pag, reg, pgs, vivo, contas] = await Promise.all([
    indicadores(p), funil(p), porHorario(p), porOrigem(p), porPagamento(p), porRegiao(p),
    porPagina(p),
    /* Fora do período de propósito: "agora" não tem recorte. */
    aoVivo(loja.id),
    db.select({ id: adAccounts.id }).from(adAccounts)
      .where(and(eq(adAccounts.tenantId, loja.id), eq(adAccounts.active, true))),
  ]);

  /*
   * O Resumo também mantém o gasto fresco.
   *
   * Antes ele só LIA `ad_spend_daily` e dependia de alguém abrir uma tela de
   * plataforma para o dado existir. Quem entra direto aqui — que é a maioria,
   * é a tela inicial — via lucro e ROAS calculados sobre gasto velho ou
   * ausente, sem nada dizendo que faltava buscar.
   *
   * Sem filtro de plataforma: aqui o número é o total, então todas contam.
   */
  const diasDaJanela = Math.max(
    1,
    Math.round((new Date(ate + "T12:00:00Z").getTime()
      - new Date(de + "T12:00:00Z").getTime()) / 86400_000) + 1,
  );
  const buscar = await precisaBuscarGasto(loja.id, { de, dias: diasDaJanela });
  if (buscar) {
    after(async () => {
      try {
        await sincronizarGasto(loja.id, { dias: buscar });
      } catch { /* falha de sincronização não pode derrubar a tela */ }
    });
  }

  return (
    <Resumo
      periodo={periodo}
      temGasto={contas.length > 0}
      ind={ind} funil={fun} horario={hor} origens={ori} pagamento={pag} regioes={reg}
      paginas={pgs}
      aoVivo={vivo}
    />
  );
}
