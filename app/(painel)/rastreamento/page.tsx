import { redirect } from "next/navigation";
import { contexto } from "@/core/sessao";
import { lojaAtual } from "@/core/loja-atual";
import { janelaDe, um, PERIODO_PADRAO } from "@/core/janela";
import { porAtribuicao, qualidadePorGateway, resumoDisparos, ultimosDisparos } from "@/core/rastreio";
import { Saude } from "@/ui/saude";

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

  const [atr, gws, res, ult] = await Promise.all([
    porAtribuicao(p), qualidadePorGateway(p), resumoDisparos(p), ultimosDisparos(p),
  ]);

  return <Saude periodo={periodo} atribuicao={atr} gateways={gws} disparos={res} ultimos={ult} />;
}
