"use client";

import { useState } from "react";

/*
 * Quanto o gateway fica de cada venda.
 *
 * Só entra em cena quando o webhook não informa a taxa — o que é o caso da
 * Appmax e da MillionsPay. Sem a tabela, o painel mostra R$ 0,00 de taxa e
 * declara um lucro que não existe: numa operação com 4% de taxa e 20% de
 * margem, ignorar a taxa erra o lucro em um quinto.
 *
 * O gateway que informa a taxa continua mandando. Isto é estimativa do
 * lojista; o webhook é o que saiu da conta, com promoção e antecipação já
 * dentro.
 */

export interface Faixa {
  ateParcelas: number; percentual: number; fixoCents: number;
  /* Reserva financeira, somada ao percentual — ver core/taxas.ts. */
  reservaPercentual?: number;
}

export interface Tabela {
  pix?: { percentual: number; fixoCents: number; reservaPercentual?: number };
  credit_card?: Faixa[];
  /*
   * A tela não edita estes, mas eles existem na tabela e precisam sobreviver a
   * um salvamento — ver `montar`. Boleto de gateway bloqueado hoje vira boleto
   * liberado amanhã, e a taxa não pode sumir no meio do caminho.
   */
  boleto?: { percentual: number; fixoCents: number };
  debit_card?: { percentual: number; fixoCents: number };
  outros?: { percentual: number; fixoCents: number };
}

/* Faixas que os gateways brasileiros praticam com mais frequência. Chute
   informado para partir de algum lugar, não verdade — daí o aviso na tela. */
const SUGERIDO: Required<Pick<Tabela, "pix" | "credit_card">> = {
  pix: { percentual: 0.99, fixoCents: 0 },
  credit_card: [
    { ateParcelas: 1, percentual: 3.99, fixoCents: 49 },
    { ateParcelas: 6, percentual: 4.99, fixoCents: 49 },
    { ateParcelas: 12, percentual: 5.99, fixoCents: 49 },
  ],
};

export function TaxasDoGateway({
  taxas, aberto, abrir, fechar, salvando, gravar,
}: {
  taxas: Record<string, unknown>;
  aberto: boolean;
  abrir: () => void;
  fechar: () => void;
  salvando: boolean;
  gravar: (t: Tabela) => void;
}) {
  const atual = taxas as Tabela;
  const configurado = !!(atual?.pix || atual?.credit_card?.length);

  /* Espelha as três colunas dos painéis de gateway: percentual, fixo, reserva. */
  const [pixPct, setPixPct] = useState(
    atual?.pix ? String(atual.pix.percentual).replace(".", ",") : "");
  const [pixFixo, setPixFixo] = useState(
    atual?.pix ? (atual.pix.fixoCents / 100).toFixed(2).replace(".", ",") : "");
  const [cartaoFixo, setCartaoFixo] = useState(
    atual?.credit_card?.[0] ? (atual.credit_card[0].fixoCents / 100).toFixed(2).replace(".", ",") : "");
  const [pixReserva, setPixReserva] = useState(
    atual?.pix?.reservaPercentual ? String(atual.pix.reservaPercentual).replace(".", ",") : "");
  const [cartaoReserva, setCartaoReserva] = useState(
    atual?.credit_card?.[0]?.reservaPercentual
      ? String(atual.credit_card[0].reservaPercentual).replace(".", ",") : "");
  const [faixas, setFaixas] = useState<Faixa[]>(
    atual?.credit_card?.length ? atual.credit_card : SUGERIDO.credit_card);

  /* Aceita vírgula, que é como se escreve número no Brasil. */
  const numero = (s: string) => {
    const n = parseFloat(String(s).replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  };

  function montar(): Tabela {
    /*
     * Parte do que já estava gravado, e não de um objeto vazio.
     *
     * A tela edita Pix e cartão; a tabela também aceita boleto, débito e a
     * regra de reserva `outros`. Montar do zero apagaria em silêncio o que
     * esta tela não conhece — e apagar taxa de boleto não dá erro nenhum, só
     * volta a inflar o lucro daquelas vendas.
     */
    const t: Tabela = { ...atual };

    if (pixPct.trim() || pixFixo.trim()) {
      t.pix = {
        percentual: numero(pixPct),
        fixoCents: Math.round(numero(pixFixo) * 100),
        ...(pixReserva.trim() ? { reservaPercentual: numero(pixReserva) } : {}),
      };
    } else {
      delete t.pix;
    }

    if (faixas.length) {
      const fixo = Math.round(numero(cartaoFixo) * 100);
      const reserva = cartaoReserva.trim() ? numero(cartaoReserva) : undefined;
      t.credit_card = faixas.map((f) => ({
        ...f, fixoCents: fixo,
        ...(reserva === undefined ? {} : { reservaPercentual: reserva }),
      }));
    } else {
      delete t.credit_card;
    }

    return t;
  }

  if (!aberto) {
    return (
      <Rodape>
        <span style={{ fontSize: 11.5, color: "var(--ink-tenue)", flexGrow: 1, minWidth: 0 }}>
          {configurado ? (
            <>
              Taxas cadastradas
              {atual.pix ? <> · Pix <span className="num">{atual.pix.percentual}%</span></> : null}
              {atual.credit_card?.[0]
                ? <> · Cartão a partir de <span className="num">{atual.credit_card[0].percentual}%</span></>
                : null}
            </>
          ) : (
            <span style={{ color: "var(--alerta)" }}>
              Sem taxas cadastradas — o lucro aparece maior do que é
            </span>
          )}
        </span>
        <Botao onClick={abrir}>{configurado ? "Editar taxas" : "Cadastrar taxas"}</Botao>
      </Rodape>
    );
  }

  return (
    <div style={{
      marginTop: 10, paddingTop: 12, borderTop: "1px solid var(--linha)",
      display: "flex", flexDirection: "column", gap: 13,
    }}>
      <div style={{ fontSize: 11.5, color: "var(--ink-tenue)", lineHeight: 1.5 }}>
        Confira no extrato do gateway e ajuste. Quando o webhook informar a taxa
        cobrada, ela prevalece — isto aqui é estimativa, aquilo é o que saiu da conta.
        <br />
        A <strong>reserva</strong> é dinheiro retido que volta depois do prazo de
        garantia. Preenchida, ela soma ao percentual e sai do lucro — o número
        passa a ser o que pinga hoje, não o que pinga somando o que ainda volta.
      </div>

      <div>
        <Rotulo>Pix</Rotulo>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <ComSufixo sufixo="%">
            <input className="num" value={pixPct} placeholder="0,99"
              onChange={(e) => setPixPct(e.target.value)} />
          </ComSufixo>
          <ComSufixo sufixo="R$">
            <input className="num" value={pixFixo} placeholder="0,00"
              onChange={(e) => setPixFixo(e.target.value)} />
          </ComSufixo>
          <ComSufixo sufixo="% reserva">
            <input className="num" value={pixReserva} placeholder="0"
              onChange={(e) => setPixReserva(e.target.value)} />
          </ComSufixo>
        </div>
      </div>

      <div>
        <Rotulo>Cartão de crédito, por faixa de parcelamento</Rotulo>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {faixas.map((f, i) => (
            <div key={i} style={{
              display: "grid", gridTemplateColumns: "28px 1fr 1fr 26px",
              gap: 7, alignItems: "center",
            }}>
              <span style={{ fontSize: 11, color: "var(--ink-tenue)" }}>até</span>
              <ComSufixo sufixo="x">
                <input className="num" value={f.ateParcelas}
                  onChange={(e) => setFaixas((v) => v.map((x, j) => j === i
                    ? { ...x, ateParcelas: Math.max(1, Math.round(numero(e.target.value))) } : x))} />
              </ComSufixo>
              <ComSufixo sufixo="%">
                <input className="num" value={String(f.percentual).replace(".", ",")}
                  onChange={(e) => setFaixas((v) => v.map((x, j) => j === i
                    ? { ...x, percentual: numero(e.target.value) } : x))} />
              </ComSufixo>
              <button onClick={() => setFaixas((v) => v.filter((_, j) => j !== i))}
                aria-label="Remover faixa" title="Remover faixa"
                style={{
                  width: 24, height: 24, borderRadius: 4, padding: 0,
                  border: "1px solid var(--linha-forte)", background: "transparent",
                  color: "var(--ink-tenue)", fontSize: 11,
                }}>✕</button>
            </div>
          ))}
          <button onClick={() => setFaixas((v) => [...v, {
            ateParcelas: (v[v.length - 1]?.ateParcelas ?? 0) + 6, percentual: 0, fixoCents: 0,
          }])} style={{
            alignSelf: "flex-start", padding: "4px 10px", borderRadius: 4, fontSize: 11,
            border: "1px dashed var(--linha-forte)", background: "transparent",
            color: "var(--ink-fraco)",
          }}>+ faixa</button>
        </div>

        <div style={{ marginTop: 9, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div>
            <Rotulo>Parte fixa do cartão</Rotulo>
            <ComSufixo sufixo="R$ por venda">
              <input className="num" value={cartaoFixo} placeholder="0,49"
                onChange={(e) => setCartaoFixo(e.target.value)} />
            </ComSufixo>
          </div>
          <div>
            <Rotulo>Reserva do cartão</Rotulo>
            <ComSufixo sufixo="%">
              <input className="num" value={cartaoReserva} placeholder="0"
                onChange={(e) => setCartaoReserva(e.target.value)} />
            </ComSufixo>
          </div>
        </div>

        <div style={{ fontSize: 11, color: "var(--ink-tenue)", marginTop: 7, lineHeight: 1.45 }}>
          A última faixa vale para qualquer parcelamento acima dela.
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <Botao onClick={() => {
          setPixPct("0,99"); setPixFixo("0,00");
          setCartaoFixo("0,49"); setFaixas(SUGERIDO.credit_card);
        }} style={{ marginRight: "auto" }}>Usar valores comuns</Botao>
        <Botao onClick={fechar}>Cancelar</Botao>
        <button onClick={() => gravar(montar())} disabled={salvando} style={{
          padding: "6px 14px", borderRadius: 5, fontSize: 11.5, fontWeight: 600,
          border: "none", background: "var(--acento)", color: "#062026",
          opacity: salvando ? .6 : 1,
        }}>{salvando ? "salvando…" : "Salvar taxas"}</button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- peças -- */

function Rodape({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--linha)",
      display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
    }}>{children}</div>
  );
}

function Botao({ children, onClick, style }: {
  children: React.ReactNode; onClick: () => void; style?: React.CSSProperties;
}) {
  return (
    <button onClick={onClick} style={{
      padding: "5px 11px", borderRadius: 4, fontSize: 11, fontWeight: 500,
      border: "1px solid var(--linha-forte)", background: "transparent",
      color: "var(--ink-fraco)", ...style,
    }}>{children}</button>
  );
}

function Rotulo({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10, letterSpacing: ".07em", textTransform: "uppercase",
      color: "var(--ink-tenue)", fontWeight: 600, marginBottom: 6,
    }}>{children}</div>
  );
}

/*
 * Sufixo dentro do campo. Fora dele, "%" e "R$" viram rótulo solto que não
 * diz a qual dos dois campos da linha pertence.
 */
function ComSufixo({ sufixo, children }: { sufixo: string; children: React.ReactNode }) {
  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
      {children}
      <span style={{
        position: "absolute", right: 9, fontSize: 10, whiteSpace: "nowrap",
        color: "var(--ink-tenue)", pointerEvents: "none",
      }}>{sufixo}</span>
    </div>
  );
}
