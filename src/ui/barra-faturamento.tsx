import type { Placar } from "@/core/faixas";

/*
 * O placar de faturamento acumulado, no topo do painel.
 *
 * É a única coisa da tela que não serve para decidir nada — serve para ver
 * distância. Todo o resto do RRTrack mostra recorte de período, e período
 * curto esconde progresso: uma semana ruim parece derrota mesmo quando o
 * acumulado dobrou no trimestre.
 *
 * Por isso o número é de sempre, nunca reinicia, e a barra mede o caminho
 * dentro da faixa atual em vez do total absoluto. Alguém em 60 mil está a 20%
 * entre 50 e 100 mil; mostrar 6% de um milhão faria a barra parecer parada
 * durante meses de trabalho real.
 */

/** "R$ 1,2 mi", "R$ 340 mil", "R$ 8.450". */
function curto(cents: number): string {
  const reais = cents / 100;
  if (reais >= 1_000_000) {
    const mi = reais / 1_000_000;
    return "R$ " + mi.toLocaleString("pt-BR", {
      minimumFractionDigits: 0, maximumFractionDigits: mi < 10 ? 1 : 0,
    }) + " mi";
  }
  if (reais >= 1_000) {
    return "R$ " + Math.round(reais / 1_000).toLocaleString("pt-BR") + " mil";
  }
  return "R$ " + reais.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

const exato = (cents: number) =>
  "R$ " + (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function BarraFaturamento({ placar, moeda }: { placar: Placar; moeda: string }) {
  const { totalCents, deCents, ateCents, faltamCents, progresso, degrau, totalDegraus } = placar;
  const cheia = ateCents === null;

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 16,
      padding: "9px 20px", borderBottom: "1px solid var(--linha)",
      background: "var(--painel)",
    }}>

      {/* o número, que é o que se olha primeiro */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexShrink: 0 }}>
        <span
          className="num"
          title={exato(totalCents) + " · sem frete nem juros"}
          style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-.3px", color: "var(--ink)" }}
        >{curto(totalCents)}</span>
        <span
          title="Frete e juros ficam de fora: são dinheiro de passagem, do transportador e do gateway."
          style={{ fontSize: 10.5, color: "var(--ink-tenue)", whiteSpace: "nowrap" }}
        >acumulado líquido{moeda !== "BRL" ? ` · ${moeda}` : ""}</span>
      </div>

      {/* a barra */}
      <div style={{ flexGrow: 1, minWidth: 90, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{
          height: 5, borderRadius: 3, background: "var(--linha)", overflow: "hidden",
        }}>
          <div style={{
            height: "100%", borderRadius: 3,
            /* Um traço mínimo mesmo em progresso quase zero: barra vazia e barra
               "ainda não começou" parecem a mesma coisa, e não são. */
            width: `${Math.max(progresso * 100, totalCents > 0 ? 1.5 : 0)}%`,
            background: cheia ? "var(--positivo)" : "var(--acento)",
            transition: "width .5s ease",
          }} />
        </div>
        <div style={{
          display: "flex", justifyContent: "space-between",
          fontSize: 9.5, color: "var(--ink-tenue)", letterSpacing: ".02em",
        }}>
          <span>{deCents === 0 ? "R$ 0" : curto(deCents)}</span>
          <span>{cheia ? "sem teto" : curto(ateCents)}</span>
        </div>
      </div>

      {/* quanto falta — a informação que a barra sozinha não dá */}
      <div style={{ flexShrink: 0, textAlign: "right" }}>
        {cheia ? (
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--positivo)" }}>
            última faixa
          </div>
        ) : (
          <>
            <div className="num" style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink-fraco)" }}>
              faltam {curto(faltamCents!)}
            </div>
            <div style={{ fontSize: 9.5, color: "var(--ink-tenue)" }}>
              faixa {degrau} de {totalDegraus}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
