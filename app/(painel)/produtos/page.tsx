import { redirect } from "next/navigation";
import { contexto } from "@/core/sessao";
import { lojaAtual } from "@/core/loja-atual";
import { skusComCusto } from "@/core/custos";
import { Produtos } from "@/ui/produtos";

export const dynamic = "force-dynamic";

export default async function Pagina() {
  const ctx = await contexto();
  if (!ctx) redirect("/entrar");
  const loja = await lojaAtual(ctx);
  if (!loja) return <div style={{ padding: 40, color: "var(--ink-fraco)" }}>Nenhuma loja cadastrada.</div>;

  return <Produtos tenantId={loja.id} skus={await skusComCusto(loja.id)} />;
}
