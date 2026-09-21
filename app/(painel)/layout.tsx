import { redirect } from "next/navigation";
import { contexto } from "@/core/sessao";
import { lojaAtual, lojaDoEndereco } from "@/core/loja-atual";
import { ProvedorDeMoeda } from "@/ui/moeda";
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

  /*
   * O endereço decide a loja, quando ele sabe responder — ver core/loja-atual.ts.
   *
   * `prende` também governa o SELETOR: em `track.<oferta>` não há o que
   * trocar, e um seletor ali só serviria para alguém abrir a oferta errada por
   * engano. No domínio do RRTrack ele continua, porque lá o painel é console.
   */
  const endereco = await lojaDoEndereco(ctx);
  const loja = endereco.prende ? endereco.loja : await lojaAtual(ctx);

  /*
   * Endereço de uma loja que não é sua: DIZ isso.
   *
   * Antes daqui, cair no cookie mostrava outra loja — nome certo na barra de
   * endereço, dado de outra oferta na tela. Uma tela vazia dizendo "nenhuma
   * loja cadastrada" seria igualmente mentira: a loja existe, o acesso é que
   * não.
   */
  if (endereco.prende && !endereco.loja) {
    return (
      <div style={{ padding: 48, maxWidth: 560, color: "var(--ink-fraco)", lineHeight: 1.6 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--ink)", marginBottom: 8 }}>
          Este painel é de outra loja
        </div>
        <p style={{ fontSize: 13 }}>
          Este endereço é o painel de{" "}
          <span className="num">{endereco.dominio}</span>, e a sua conta não tem
          acesso a ela. Se era para ter, peça a quem administra essa loja.
        </p>
      </div>
    );
  }

  /*
   * O placar é acumulado de sempre, então não depende do período escolhido em
   * nenhuma tela — pode viver no layout e ser calculado uma vez por navegação.
   */
  const placar = loja ? await placarDaLoja(loja.id) : null;

  /*
   * A moeda entra aqui e desce por contexto para todas as telas.
   *
   * Antes cada uma escrevia "R$" na mão. Numa loja em libra isso mostraria
   * "R$ 1.234,56" para £1.234,56 — número errado com cara de certo. Entrando
   * uma vez no topo, nenhuma tela precisa lembrar, e nenhuma pode esquecer.
   */
  return (
    <ProvedorDeMoeda moeda={loja?.currency ?? "BRL"}>
      <div className="rr-quadro" style={{ display: "flex", minHeight: "100vh" }}>
        <Navegacao lojaAtual={loja} lojas={endereco.prende ? [] : ctx.lojas} usuario={ctx.usuario} />
        <main style={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {placar && <BarraFaturamento placar={placar} moeda={loja!.currency} />}
          {children}
        </main>
      </div>
    </ProvedorDeMoeda>
  );
}
