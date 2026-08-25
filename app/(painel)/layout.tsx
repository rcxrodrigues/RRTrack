import { redirect } from "next/navigation";
import { contexto } from "@/core/sessao";
import { lojaAtual } from "@/core/loja-atual";
import { Navegacao } from "@/ui/navegacao";
import { BarraFaturamento } from "@/ui/barra-faturamento";
import { placarDaLoja } from "@/core/faixas";

export default async function PainelLayout({ children }: { children: React.ReactNode }) {
  /*
   * Aqui é onde a sessão é validada de verdade. O middleware só olhou se
   * existe cookie; quem decide o que a pessoa pode ver é esta linha, e ela
   * roda antes de qualquer tela do painel renderizar.
   */
  const ctx = await contexto();
  if (!ctx) redirect("/entrar");

  const loja = await lojaAtual(ctx);

  /*
   * O placar é acumulado de sempre, então não depende do período escolhido em
   * nenhuma tela — pode viver no layout e ser calculado uma vez por navegação.
   */
  const regra = loja
    ? { countShipping: loja.countShipping, countInterest: loja.countInterest }
    : null;
  const placar = loja ? await placarDaLoja(loja.id) : null;

  return (
    <div className="rr-quadro" style={{ display: "flex", minHeight: "100vh" }}>
      <Navegacao lojaAtual={loja} lojas={ctx.lojas} usuario={ctx.usuario} />
      <main style={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {placar && <BarraFaturamento placar={placar} moeda={loja!.currency} />}
        {children}
      </main>
    </div>
  );
}
