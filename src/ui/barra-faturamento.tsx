import type { Placar } from "@/core/faixas";

/*
 * O placar de faturamento acumulado, no topo do painel.
 *
 * É a única coisa da tela que não serve para decidir nada — serve para ver
 * distância. Todo o resto do RRTrack mostra recorte de período, e período
 * curto esconde progresso: uma semana ruim parece derrota mesmo quando o
 * acumulado dobrou no trimestre.
 *
 * Um rótulo, dois números e uma barra. Havia aqui "faltam R$ X" e "faixa 3 de
 * 9"; saíram porque transformavam um lembrete de progresso numa régua de metas
 * que ninguém pediu — e a barra já diz a mesma coisa sem escrever.
 */

const SIMBOLO: Record<string, string> = { BRL: "R$", USD: "US$", EUR: "€" };

/** "R$ 1,2 mi", "R$ 340 mil", "R$ 796". */
function curto(cents: number, moeda: string): string {
  const s = SIMBOLO[moeda] ?? moeda;
  const valor = cents / 100;

  if (valor >= 1_000_000) {
    const mi = valor / 1_000_000;
    return `${s} ` + mi.toLocaleString("pt-BR", {
      minimumFractionDigits: 0, maximumFractionDigits: mi < 10 ? 1 : 0,
    }) + " mi";
  }
  if (valor >= 1_000) {
    return `${s} ` + Math.round(valor / 1_000).toLocaleString("pt-BR") + " mil";
  }
  return `${s} ` + valor.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
}

function exato(cents: number, moeda: string): string {
  const s = SIMBOLO[moeda] ?? moeda;
  return `${s} ` + (cents / 100).toLocaleString("pt-BR", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

export function BarraFaturamento({ placar, moeda }: { placar: Placar; moeda: string }) {
  const { totalCents, ateCents, progresso } = placar;
  const cheia = ateCents === null;

  return (
    <div className="rr-barra" style={{
      padding: "9px 20px 10px", borderBottom: "1px solid var(--linha)",
      background: "var(--painel)", display: "flex", flexDirection: "column", gap: 6,
    }}>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="var(--acento)"
               strokeWidth="1.5" style={{ flexShrink: 0 }}>
            <path d="M5 2.5h6v3a3 3 0 0 1-6 0v-3zM5 3.5H3v1a2 2 0 0 0 2 2M11 3.5h2v1a2 2 0 0 1-2 2M8 8.5v3M6 13.5h4" />
          </svg>
          <span style={{
            fontSize: 11, fontWeight: 600, color: "var(--ink-fraco)",
            letterSpacing: ".02em", whiteSpace: "nowrap",
          }}>Acumulado</span>
          {/*
            O que entra na conta não cabe no rótulo, mas quem olha um número de
            faturamento acaba querendo saber — então mora aqui, a um passar de
            mouse, em vez de virar mais uma linha de texto na barra.
          */}
          <span
            title="Soma de todas as vendas pagas, desde o primeiro dia. Frete e juros ficam de fora: são dinheiro de passagem, do transportador e do gateway."
            aria-label="O que entra nesta conta"
            style={{
              flexShrink: 0, width: 12, height: 12, borderRadius: "50%", cursor: "help",
              border: "1px solid var(--ink-tenue)", color: "var(--ink-tenue)",
              fontSize: 8.5, lineHeight: "10px", textAlign: "center", fontWeight: 700,
            }}
          >i</span>
        </div>

        <div className="num" style={{ fontSize: 12, whiteSpace: "nowrap", flexShrink: 0 }}>
          <span
            title={exato(totalCents, moeda)}
            style={{ fontWeight: 700, color: "var(--ink)" }}
          >{curto(totalCents, moeda)}</span>
          <span style={{ color: "var(--ink-tenue)", fontWeight: 500 }}>
            {" / "}{cheia ? "sem teto" : curto(ateCents, moeda)}
          </span>
        </div>
      </div>

      <div style={{
        height: 5, borderRadius: 3, background: "var(--linha)", overflow: "hidden",
      }}>
        <div style={{
          height: "100%", borderRadius: 3,
          /*
           * Um traço mínimo enquanto houver qualquer venda: barra vazia e barra
           * "ainda não começou" parecem a mesma coisa, e não são.
           */
          width: `${Math.max(progresso * 100, totalCents > 0 ? 1.5 : 0)}%`,
          background: cheia ? "var(--positivo)" : "var(--acento)",
          transition: "width .5s ease",
        }} />
      </div>
    </div>
  );
}
