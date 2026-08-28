import { redirect } from "next/navigation";
import { contexto } from "@/core/sessao";
import { lojaAtual } from "@/core/loja-atual";
import { listarCheckouts, opcoesDoFormulario } from "@/checkout/gestao";
import { Checkouts } from "@/ui/checkouts";

export const dynamic = "force-dynamic";

export default async function Pagina() {
  const ctx = await contexto();
  if (!ctx) redirect("/entrar");

  const loja = await lojaAtual(ctx);
  if (!loja) {
    return <div style={{ padding: 40, color: "var(--ink-fraco)" }}>Nenhuma loja cadastrada.</div>;
  }

  const [checkouts, opcoes] = await Promise.all([
    listarCheckouts(loja.id),
    opcoesDoFormulario(loja.id),
  ]);

  /* Mesmo endereço que a tela de Integrações usa para montar o snippet. */
  const base = process.env.RR_BASE ?? "https://rr-track.vercel.app";

  return (
    <Checkouts tenantId={loja.id} checkouts={checkouts} opcoes={opcoes} base={base} />
  );
}
