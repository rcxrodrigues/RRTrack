import { redirect } from "next/navigation";
import { contexto } from "@/core/sessao";
import { lojaAtual } from "@/core/loja-atual";
import { Navegacao } from "@/ui/navegacao";

export default async function PainelLayout({ children }: { children: React.ReactNode }) {
  /*
   * Aqui é onde a sessão é validada de verdade. O middleware só olhou se
   * existe cookie; quem decide o que a pessoa pode ver é esta linha, e ela
   * roda antes de qualquer tela do painel renderizar.
   */
  const ctx = await contexto();
  if (!ctx) redirect("/entrar");

  const loja = await lojaAtual(ctx);

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <Navegacao lojaAtual={loja} usuario={ctx.usuario} />
      <main style={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {children}
      </main>
    </div>
  );
}
