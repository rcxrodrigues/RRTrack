import { redirect } from "next/navigation";
import { contexto } from "@/core/sessao";
import { lojaAtual } from "@/core/loja-atual";
import { janelaDe, um, PERIODO_PADRAO } from "@/core/janela";
import { porUtm } from "@/core/rastreio";
import { Utms } from "@/ui/utms";

export const dynamic = "force-dynamic";

const NIVEIS = ["fonte", "campanha", "conteudo"] as const;

export default async function Pagina({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await contexto();
  if (!ctx) redirect("/entrar");
  const loja = await lojaAtual(ctx);
  if (!loja) return <div style={{ padding: 40, color: "var(--ink-fraco)" }}>Nenhuma loja cadastrada.</div>;

  const busca = await searchParams;
  const periodo = um(busca.periodo) || PERIODO_PADRAO;
  const pedido = um(busca.agrupar);
  const agrupar = (NIVEIS as readonly string[]).includes(pedido)
    ? (pedido as (typeof NIVEIS)[number]) : "fonte";

  /* As datas do personalizado vêm da URL, como o período — ver core/janela.ts. */
  const { de, ate } = janelaDe(periodo, loja.timezone, {
    de: um(busca.de), ate: um(busca.ate),
  });
  const linhas = await porUtm(
    { tenantId: loja.id, de, ate, timezone: loja.timezone, moeda: loja.currency },
    agrupar,
  );

  return <Utms periodo={periodo} agrupar={agrupar} linhas={linhas} />;
}
