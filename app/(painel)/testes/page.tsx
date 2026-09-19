import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db/index";
import { sites } from "@/db/schema";
import { contexto } from "@/core/sessao";
import { lojaAtual } from "@/core/loja-atual";
import { um } from "@/core/janela";
import { verificacoes, eventosRecentes, entregasRecentes } from "@/core/diagnostico";
import { Testes } from "@/ui/testes";

export const dynamic = "force-dynamic";

export default async function Pagina({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await contexto();
  if (!ctx) redirect("/entrar");
  const loja = await lojaAtual(ctx);
  if (!loja) return <div style={{ padding: 40, color: "var(--ink-fraco)" }}>Nenhuma loja cadastrada.</div>;

  const busca = await searchParams;

  const [checks, eventos, entregas, site] = await Promise.all([
    verificacoes(loja.id),
    eventosRecentes(loja.id),
    entregasRecentes(loja.id),
    db.select({ id: sites.id }).from(sites)
      .where(and(eq(sites.tenantId, loja.id), eq(sites.active, true)))
      .orderBy(sites.domain).limit(1),
  ]);

  return (
    <Testes
      periodo={um(busca.periodo) || "7d"}
      verificacoes={checks}
      eventos={eventos}
      entregas={entregas}
      temSite={site.length > 0}
    />
  );
}
