"use client";

import { useEffect, useState } from "react";
import type { LinhaMetrica } from "@/core/metricas";

/*
 * Quais colunas a tabela mostra, e em que ordem.
 *
 * O catálogo é a única fonte: rótulo, largura, formato e alinhamento saem
 * daqui, e a tabela só percorre a lista. Acrescentar uma métrica nova é uma
 * entrada aqui mais um campo em LinhaMetrica — a tela não muda.
 *
 * A escolha vive no localStorage, por plataforma. É preferência de quem opera,
 * não dado de negócio: não vale uma tabela no banco nem uma ida ao servidor a
 * cada marcação. O custo é não seguir a pessoa para outro computador, e para
 * uma tela que se opera de um lugar só isso é barato.
 */

export type Formato = "texto" | "dinheiro" | "numero" | "razao" | "pct" | "quando";

export interface Coluna {
  id: string;
  rotulo: string;
  largura: string;
  formato: Formato;
  /** Lê o valor da linha. */
  valor: (l: LinhaMetrica) => number | string | null;
  /** Realce: lucro e ROAS mudam de cor conforme o número. */
  realce?: "valor" | "roas";
  /** Discreta: métrica de apoio, em cinza. */
  fraca?: boolean;
  ajuda?: string;
}

/*
 * A coluna de nome não entra no catálogo: ela é sempre a primeira, sempre
 * visível, e seu rótulo muda com o nível — "Campanha" numa aba, "Anúncio" na
 * outra. Deixá-la desligável só daria uma tabela de números sem dizer de quê.
 */
export const CATALOGO: Coluna[] = [
  { id: "vendas", rotulo: "Vendas", largura: "0.7fr", formato: "numero", valor: (l) => l.vendas },
  { id: "cpa", rotulo: "CPA", largura: "0.9fr", formato: "dinheiro", valor: (l) => l.cpaCents, fraca: true,
    ajuda: "Gasto dividido pelas vendas atribuídas ao nosso rastreamento." },
  { id: "gastos", rotulo: "Gastos", largura: "1fr", formato: "dinheiro", valor: (l) => l.gastoCents },
  { id: "faturamento", rotulo: "Faturamento", largura: "1.1fr", formato: "dinheiro", valor: (l) => l.faturamentoCents },
  { id: "lucro", rotulo: "Lucro", largura: "1.1fr", formato: "dinheiro", valor: (l) => l.lucroCents, realce: "valor",
    ajuda: "Faturamento menos gasto menos custo do produto, onde o custo está cadastrado." },
  { id: "roas", rotulo: "ROAS", largura: "0.7fr", formato: "razao", valor: (l) => l.roas, realce: "roas" },
  { id: "margem", rotulo: "Margem", largura: "0.85fr", formato: "pct", valor: (l) => l.margem, realce: "valor" },
  { id: "roi", rotulo: "ROI", largura: "0.7fr", formato: "razao", valor: (l) => l.roi, realce: "valor",
    ajuda: "Lucro sobre gasto. Diferente do ROAS, que é faturamento sobre gasto." },
  { id: "ic", rotulo: "IC", largura: "0.6fr", formato: "numero", valor: (l) => l.ic, fraca: true,
    ajuda: "Finalizações de compra iniciadas, contadas pelo nosso rastreamento — não pelo que a plataforma reporta." },
  { id: "cpi", rotulo: "CPI", largura: "0.85fr", formato: "dinheiro", valor: (l) => l.cpiCents, fraca: true,
    ajuda: "Custo por finalização de compra iniciada." },
  { id: "cpc", rotulo: "CPC", largura: "0.85fr", formato: "dinheiro", valor: (l) => l.cpcCents, fraca: true },
  { id: "ctr", rotulo: "CTR", largura: "0.75fr", formato: "pct", valor: (l) => l.ctr, fraca: true },
  { id: "cpm", rotulo: "CPM", largura: "0.9fr", formato: "dinheiro", valor: (l) => l.cpmCents, fraca: true },
  { id: "impressoes", rotulo: "Impressões", largura: "0.95fr", formato: "numero", valor: (l) => l.impressoes, fraca: true },
  { id: "cliques", rotulo: "Cliques", largura: "0.75fr", formato: "numero", valor: (l) => l.cliques, fraca: true },
  { id: "atualizado", rotulo: "Última Atualização", largura: "1.1fr", formato: "quando",
    valor: (l) => l.atualizadoEmMs, fraca: true,
    ajuda: "Quando o gasto desta linha foi buscado na plataforma pela última vez." },
];

const POR_ID = new Map(CATALOGO.map((c) => [c.id, c]));

/*
 * O padrão liga tudo menos "Última Atualização": é metadado de sincronização,
 * não métrica de decisão, e ocupa espaço numa tabela que já rola na horizontal.
 */
export const PADRAO = CATALOGO.filter((c) => c.id !== "atualizado").map((c) => c.id);

const CHAVE = (plataforma: string) => `rr_colunas_${plataforma}`;

/** Lê a escolha salva, descartando id que não existe mais no catálogo. */
export function carregarEscolha(plataforma: string): string[] {
  if (typeof window === "undefined") return PADRAO;
  try {
    const bruto = window.localStorage.getItem(CHAVE(plataforma));
    if (!bruto) return PADRAO;
    const ids = (JSON.parse(bruto) as string[]).filter((id) => POR_ID.has(id));
    /* Escolha que ficou vazia — catálogo mudou, ou o usuário desmarcou tudo e
       o navegador salvou — volta ao padrão em vez de mostrar tabela sem coluna. */
    return ids.length ? ids : PADRAO;
  } catch {
    return PADRAO;
  }
}

export function salvarEscolha(plataforma: string, ids: string[]) {
  try {
    window.localStorage.setItem(CHAVE(plataforma), JSON.stringify(ids));
  } catch { /* modo privado, cota cheia: segue com o padrão da sessão */ }
}

export function colunasDe(ids: string[]): Coluna[] {
  return ids.map((id) => POR_ID.get(id)).filter((c): c is Coluna => !!c);
}

/* ------------------------------------------------------------ diálogo -- */

export function DialogoColunas({
  plataforma, escolhidas, aoSalvar, aoFechar,
}: {
  plataforma: string;
  escolhidas: string[];
  aoSalvar: (ids: string[]) => void;
  aoFechar: () => void;
}) {
  const [ids, setIds] = useState<string[]>(escolhidas);
  const [busca, setBusca] = useState("");

  /* Esc fecha sem salvar, como todo diálogo. */
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === "Escape") aoFechar(); };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [aoFechar]);

  const ligada = (id: string) => ids.includes(id);

  function alternar(id: string) {
    setIds((atual) =>
      atual.includes(id)
        ? atual.filter((x) => x !== id)
        /* Entra na posição do catálogo, não no fim: quem religa uma coluna
           espera encontrá-la onde estava, não deslocada para a ponta. */
        : [...atual, id].sort(
            (a, b) => CATALOGO.findIndex((c) => c.id === a) - CATALOGO.findIndex((c) => c.id === b),
          ),
    );
  }

  function mover(id: string, passo: -1 | 1) {
    setIds((atual) => {
      const i = atual.indexOf(id);
      const j = i + passo;
      if (i < 0 || j < 0 || j >= atual.length) return atual;
      const novo = [...atual];
      [novo[i], novo[j]] = [novo[j]!, novo[i]!];
      return novo;
    });
  }

  const visiveis = CATALOGO.filter((c) =>
    c.rotulo.toLowerCase().includes(busca.trim().toLowerCase()));

  return (
    <div
      onClick={aoFechar}
      style={{
        position: "fixed", inset: 0, zIndex: 50, display: "flex",
        alignItems: "center", justifyContent: "center", padding: 20,
        background: "rgba(4, 10, 14, .66)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Personalizar colunas"
        style={{
          width: "min(940px, 100%)", maxHeight: "88vh", display: "flex", flexDirection: "column",
          background: "var(--painel)", border: "1px solid var(--linha-forte)",
          borderRadius: 10, overflow: "hidden",
        }}
      >
        <div style={{ padding: "16px 20px 13px", borderBottom: "1px solid var(--linha)" }}>
          <div style={{ fontSize: 14.5, fontWeight: 700, marginBottom: 3 }}>Personalize as colunas</div>
          <div style={{ fontSize: 12, color: "var(--ink-tenue)" }}>
            Escolha o que aparece na tabela e em que ordem.
          </div>
        </div>

        <div style={{
          display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0,
          flexGrow: 1, minHeight: 0,
        }}>
          {/* disponíveis */}
          <div style={{ borderRight: "1px solid var(--linha)", display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ padding: "12px 16px 10px" }}>
              <input
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Buscar por coluna"
                style={{ width: "100%" }}
              />
            </div>
            <div style={{ overflowY: "auto", padding: "0 16px 14px", minHeight: 0 }}>
              {visiveis.length === 0 && (
                <div style={{ fontSize: 12, color: "var(--ink-tenue)", padding: "8px 2px" }}>
                  Nenhuma coluna com esse nome.
                </div>
              )}
              {visiveis.map((c) => (
                <label key={c.id} style={{
                  display: "flex", alignItems: "center", gap: 9, padding: "7px 2px",
                  fontSize: 12.5, cursor: "pointer", color: "var(--ink-medio)",
                }}>
                  <input type="checkbox" checked={ligada(c.id)} onChange={() => alternar(c.id)} />
                  <span>{c.rotulo}</span>
                </label>
              ))}
            </div>
          </div>

          {/* escolhidas, na ordem */}
          <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{
              padding: "12px 16px 8px", fontSize: 10, letterSpacing: ".07em",
              textTransform: "uppercase", color: "var(--ink-tenue)", fontWeight: 600,
            }}>
              Na tabela — {ids.length} coluna{ids.length === 1 ? "" : "s"}
            </div>
            <div style={{ overflowY: "auto", padding: "0 16px 14px", minHeight: 0 }}>
              {ids.length === 0 && (
                <div style={{
                  fontSize: 12, color: "var(--alerta)", padding: "10px 12px",
                  border: "1px dashed var(--alerta)", borderRadius: 6,
                }}>
                  Sem nenhuma coluna marcada, a tabela volta ao padrão ao salvar.
                </div>
              )}
              {colunasDe(ids).map((c, i) => (
                <div key={c.id} style={{
                  display: "flex", alignItems: "center", gap: 6, padding: "6px 10px",
                  marginBottom: 4, background: "var(--painel-alto)",
                  border: "1px solid var(--linha)", borderRadius: 5, fontSize: 12.5,
                }}>
                  <span style={{ flexGrow: 1, color: "var(--ink-medio)" }}>{c.rotulo}</span>
                  <button
                    onClick={() => mover(c.id, -1)} disabled={i === 0}
                    aria-label={`Mover ${c.rotulo} para cima`} title="Mover para cima"
                    style={botaoMini(i === 0)}
                  >↑</button>
                  <button
                    onClick={() => mover(c.id, 1)} disabled={i === ids.length - 1}
                    aria-label={`Mover ${c.rotulo} para baixo`} title="Mover para baixo"
                    style={botaoMini(i === ids.length - 1)}
                  >↓</button>
                  <button
                    onClick={() => alternar(c.id)}
                    aria-label={`Remover ${c.rotulo}`} title="Remover"
                    style={botaoMini(false)}
                  >✕</button>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          gap: 10, padding: "12px 20px", borderTop: "1px solid var(--linha)",
        }}>
          <button onClick={() => setIds(PADRAO)} style={{
            padding: "7px 12px", borderRadius: 5, border: "1px solid var(--linha-forte)",
            background: "transparent", color: "var(--ink-fraco)", fontSize: 12, fontWeight: 500,
          }}>Restaurar padrão</button>

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={aoFechar} style={{
              padding: "7px 14px", borderRadius: 5, border: "1px solid var(--linha-forte)",
              background: "transparent", color: "var(--ink-medio)", fontSize: 12, fontWeight: 500,
            }}>Cancelar</button>
            <button onClick={() => aoSalvar(ids.length ? ids : PADRAO)} style={{
              padding: "7px 16px", borderRadius: 5, border: "none",
              background: "var(--acento)", color: "#062026", fontSize: 12, fontWeight: 600,
            }}>Salvar</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function botaoMini(desligado: boolean): React.CSSProperties {
  return {
    width: 22, height: 22, lineHeight: 1, padding: 0, borderRadius: 4,
    border: "1px solid var(--linha-forte)", background: "transparent",
    color: desligado ? "var(--linha-forte)" : "var(--ink-fraco)",
    fontSize: 11, cursor: desligado ? "default" : "pointer",
  };
}
