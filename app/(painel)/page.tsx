import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db/index";
import { adAccounts } from "@/db/schema";
import { contexto } from "@/core/sessao";
import { lojaAtual } from "@/core/loja-atual";
import { janelaDe, um, PERIODO_PADRAO } from "@/core/janela";
import { indicadores, funil, porHorario, porOrigem, porPagamento } from "@/core/resumo";
import { aoVivo } from "@/core/aovivo";
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
  const p = { tenantId: loja.id, de, ate, timezone: loja.timezone, regra };

  const [ind, fun, hor, ori, pag, vivo, contas] = await Promise.all([
    indicadores(p), funil(p), porHorario(p), porOrigem(p), porPagamento(p),
    /* Fora do período de propósito: "agora" não tem recorte. */
    aoVivo(loja.id),
    db.select({ id: adAccounts.id }).from(adAccounts)
      .where(and(eq(adAccounts.tenantId, loja.id), eq(adAccounts.active, true))),
  ]);

  return (
    <Resumo
      periodo={periodo}
      temGasto={contas.length > 0}
      ind={ind} funil={fun} horario={hor} origens={ori} pagamento={pag}
      aoVivo={vivo}
    />
  );
}
