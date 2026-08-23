"use client";

import { useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import type { LinhaMetrica, Nivel } from "@/core/metricas";

/*
 * Tela de uma fonte de tráfego.
 *
 * Quatro abas irmãs — Contas, Campanhas, Conjuntos, Anúncios — e não um
 * drill-down onde se clica na campanha para abrir os conjuntos dentro dela.
 * A diferença importa na prática: drill-down serve para investigar UMA
 * campanha, aba plana serve para comparar VINTE anúncios lado a lado, que é o
 * que se faz quando se decide o que escalar e o que matar.
 */

const NIVEIS: Array<{ id: Nivel; rotulo: string; coluna: string }> = [
  { id: "conta", rotulo: "Contas", coluna: "Conta" },
  { id: "campanha", rotulo: "Campanhas", coluna: "Campanha" },
  { id: "conjunto", rotulo: "Conjuntos", coluna: "Conjunto" },
  { id: "anuncio", rotulo: "Anúncios", coluna: "Anúncio" },
];

const PERIODOS = [
  { id: "hoje", rotulo: "Hoje" },
  { id: "7d", rotulo: "Últimos 7 dias" },
  { id: "14d", rotulo: "Últimos 14 dias" },
  { id: "30d", rotulo: "Últimos 30 dias" },
];

/* -------------------------------------------------------- formatação -- */

const brl = (c: number) =>
  "R$ " + (c / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const numero = (n: number) => n.toLocaleString("pt-BR");

/*
 * `null` vira "N/A", não "0,00".
 * ROAS zero e ROAS incalculável são coisas diferentes: campanha que gastou e
 * não vendeu tem ROAS zero; campanha que não gastou não tem ROAS nenhum, e
 * escrever zero ali sugere um fracasso que não houve.
 */
const razao = (v: number | null, casas = 2) =>
  v === null ? "N/A" : v.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });

const pct = (v: number | null) =>
  v === null ? "N/A" : (v * 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%";

const dinheiroOuNa = (c: number | null) => (c === null ? "N/A" : brl(c));

function corDoValor(v: number) {
  return v > 0 ? "var(--positivo)" : v < 0 ? "var(--negativo)" : "var(--ink-medio)";
}

function corRoas(v: number | null) {
  if (v === null) return "var(--ink-tenue)";
  if (v >= 3) return "var(--positivo)";
  if (v >= 1.5) return "var(--acento)";
  if (v >= 1) return "var(--alerta)";
  return "var(--negativo)";
}

/* ------------------------------------------------------------- tela -- */

export function Plataforma({
  titulo, plataforma, tenantId, linhas, total, nivel, periodo, nome, temConta,
}: {
  titulo: string;
  plataforma: string;
  tenantId: string;
  linhas: LinhaMetrica[];
  total: LinhaMetrica;
  nivel: Nivel;
  periodo: string;
  nome: string;
  temConta: boolean;
}) {
  const router = useRouter();
  const caminho = usePathname();
  const params = useSearchParams();
  const [busca, setBusca] = useState(nome);
  const [sincronizando, setSincronizando] = useState(false);

  function ir(mudancas: Record<string, string>) {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(mudancas)) {
      if (v) p.set(k, v); else p.delete(k);
    }
    router.push(`${caminho}?${p.toString()}`);
  }

  async function sincronizar() {
    setSincronizando(true);
    await fetch("/api/sync/gasto", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId, plataforma }),
    }).catch(() => {});
    setSincronizando(false);
    router.refresh();
  }

  const colunaNome = NIVEIS.find((n) => n.id === nivel)?.coluna ?? "Nome";

  const COLS = [
    { r: colunaNome, w: "2.4fr", esq: true },
    { r: "Vendas", w: "0.7fr" },
    { r: "CPA", w: "0.9fr" },
    { r: "Gastos", w: "1fr" },
    { r: "Faturamento", w: "1.1fr" },
    { r: "Lucro", w: "1.1fr" },
    { r: "ROAS", w: "0.7fr" },
    { r: "Margem", w: "0.85fr" },
    { r: "ROI", w: "0.7fr" },
    { r: "IC", w: "0.6fr" },
    { r: "CPI", w: "0.85fr" },
    { r: "CPC", w: "0.85fr" },
    { r: "CTR", w: "0.75fr" },
    { r: "CPM", w: "0.9fr" },
    { r: "Impressões", w: "0.95fr" },
    { r: "Cliques", w: "0.75fr" },
  ];

  const grade = COLS.map((c) => c.w).join(" ");

  const celulas = (l: LinhaMetrica, forte: boolean) => [
    <span key="n" style={{
      fontWeight: forte ? 600 : 500, overflow: "hidden",
      textOverflow: "ellipsis", whiteSpace: "nowrap",
    }}>{l.nome}</span>,
    <span key="v" className="num">{numero(l.vendas)}</span>,
    <span key="cpa" className="num" style={{ color: "var(--ink-fraco)" }}>{dinheiroOuNa(l.cpaCents)}</span>,
    <span key="g" className="num">{brl(l.gastoCents)}</span>,
    <span key="f" className="num" style={{ fontWeight: 500 }}>{brl(l.faturamentoCents)}</span>,
    <span key="l" className="num" style={{ fontWeight: 600, color: corDoValor(l.lucroCents) }}>{brl(l.lucroCents)}</span>,
    <span key="r" className="num" style={{ fontWeight: 600, color: corRoas(l.roas) }}>{razao(l.roas)}</span>,
    <span key="m" className="num" style={{ color: l.margem === null ? "var(--ink-tenue)" : corDoValor(l.margem) }}>{pct(l.margem)}</span>,
    <span key="roi" className="num" style={{ color: l.roi === null ? "var(--ink-tenue)" : corDoValor(l.roi) }}>{razao(l.roi)}</span>,
    <span key="ic" className="num" style={{ color: "var(--ink-fraco)" }}>{numero(l.ic)}</span>,
    <span key="cpi" className="num" style={{ color: "var(--ink-fraco)" }}>{dinheiroOuNa(l.cpiCents)}</span>,
    <span key="cpc" className="num" style={{ color: "var(--ink-fraco)" }}>{dinheiroOuNa(l.cpcCents)}</span>,
    <span key="ctr" className="num" style={{ color: "var(--ink-fraco)" }}>{pct(l.ctr)}</span>,
    <span key="cpm" className="num" style={{ color: "var(--ink-fraco)" }}>{dinheiroOuNa(l.cpmCents)}</span>,
    <span key="i" className="num" style={{ color: "var(--ink-fraco)" }}>{numero(l.impressoes)}</span>,
    <span key="c" className="num" style={{ color: "var(--ink-fraco)" }}>{numero(l.cliques)}</span>,
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>

      {/* abas de nível */}
      <div style={{ padding: "16px 20px 0", background: "var(--painel)", borderBottom: "1px solid var(--linha)" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
          <h1 style={{ fontSize: 17, fontWeight: 700, margin: 0, letterSpacing: "-.2px" }}>{titulo}</h1>
          <button onClick={sincronizar} disabled={sincronizando || !temConta} style={{
            padding: "7px 14px", borderRadius: 5, border: "none", fontWeight: 600, fontSize: 12,
            background: temConta ? "var(--acento)" : "var(--linha)",
            color: temConta ? "#062026" : "var(--ink-tenue)",
          }}>{sincronizando ? "sincronizando…" : "Atualizar gasto"}</button>
        </div>

        <div style={{ display: "flex", gap: 4 }}>
          {NIVEIS.map((n) => (
            <button key={n.id} onClick={() => ir({ nivel: n.id })} style={{
              padding: "9px 18px", borderRadius: "6px 6px 0 0", border: "none",
              fontSize: 12.5, fontWeight: nivel === n.id ? 600 : 500,
              background: nivel === n.id ? "var(--fundo)" : "transparent",
              color: nivel === n.id ? "var(--acento)" : "var(--ink-fraco)",
              borderBottom: nivel === n.id ? "2px solid var(--acento)" : "2px solid transparent",
            }}>{n.rotulo}</button>
          ))}
        </div>
      </div>

      {/* filtros */}
      <div style={{
        display: "flex", gap: 10, padding: "12px 20px",
        borderBottom: "1px solid var(--linha)", background: "var(--painel)",
      }}>
        <div style={{ flexGrow: 1, maxWidth: 280 }}>
          <div style={{
            fontSize: 10, letterSpacing: ".07em", textTransform: "uppercase",
            color: "var(--ink-tenue)", fontWeight: 600, marginBottom: 5,
          }}>Nome</div>
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") ir({ nome: busca }); }}
            onBlur={() => ir({ nome: busca })}
            placeholder="filtrar por nome"
          />
        </div>
        <div style={{ width: 200 }}>
          <div style={{
            fontSize: 10, letterSpacing: ".07em", textTransform: "uppercase",
            color: "var(--ink-tenue)", fontWeight: 600, marginBottom: 5,
          }}>Período</div>
          <select value={periodo} onChange={(e) => ir({ periodo: e.target.value })}>
            {PERIODOS.map((p) => <option key={p.id} value={p.id}>{p.rotulo}</option>)}
          </select>
        </div>
      </div>

      {/* tabela */}
      <div style={{ flexGrow: 1, padding: "16px 20px 28px", overflowX: "auto" }}>
        {!temConta ? (
          <Vazio
            titulo="Nenhuma conta conectada"
            texto="Conecte a conta de anúncio em Integrações para o gasto entrar. Sem ele há faturamento e lucro, mas não há ROAS — não existe com o que dividir."
          />
        ) : linhas.length === 0 ? (
          <Vazio
            titulo="Nada no período"
            texto="A conta está conectada mas não há gasto registrado neste intervalo. Clique em Atualizar gasto, ou amplie o período."
          />
        ) : (
          <div style={{
            minWidth: 1500, border: "1px solid var(--linha)",
            borderRadius: 8, overflow: "hidden", background: "var(--painel)",
          }}>
            <div style={{
              display: "grid", gridTemplateColumns: grade, gap: 0,
              padding: "9px 14px", background: "var(--painel-alto)",
              borderBottom: "1px solid var(--linha-forte)",
              fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase",
              color: "var(--ink-tenue)", fontWeight: 600,
            }}>
              {COLS.map((c) => (
                <div key={c.r} style={{ textAlign: c.esq ? "left" : "right" }}>{c.r}</div>
              ))}
            </div>

            {linhas.map((l) => (
              <div key={l.id} style={{
                display: "grid", gridTemplateColumns: grade,
                padding: "9px 14px", borderBottom: "1px solid var(--linha)",
                alignItems: "center", fontSize: 12,
              }}>
                {celulas(l, false).map((c, i) => (
                  <div key={i} style={{ textAlign: i === 0 ? "left" : "right", minWidth: 0 }}>{c}</div>
                ))}
              </div>
            ))}

            <div style={{
              display: "grid", gridTemplateColumns: grade,
              padding: "11px 14px", background: "var(--painel-alto)",
              borderTop: "1px solid var(--linha-forte)",
              alignItems: "center", fontSize: 12,
            }}>
              {celulas(total, true).map((c, i) => (
                <div key={i} style={{ textAlign: i === 0 ? "left" : "right", minWidth: 0 }}>{c}</div>
              ))}
            </div>
          </div>
        )}

        {linhas.length > 0 && (
          <div style={{
            marginTop: 12, fontSize: 11.5, color: "var(--ink-tenue)",
            display: "flex", alignItems: "flex-start", gap: 7, maxWidth: 860, lineHeight: 1.5,
          }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ flexShrink: 0, marginTop: 2 }}>
              <circle cx="8" cy="8" r="6" /><path d="M8 5v3.5M8 11h.01" />
            </svg>
            <span>
              O <strong style={{ color: "var(--ink-fraco)" }}>IC</strong> é o iniciar checkout do nosso
              rastreamento, não o que a plataforma reporta — a janela de atribuição é a nossa.
              O <strong style={{ color: "var(--ink-fraco)" }}>lucro</strong> desconta o custo do produto
              só onde ele está cadastrado; sem custo, é margem sobre o anúncio, não lucro final.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function Vazio({ titulo, texto }: { titulo: string; texto: string }) {
  return (
    <div style={{
      maxWidth: 560, padding: "18px 20px", borderRadius: 8,
      background: "var(--painel)", border: "1px dashed var(--linha-forte)",
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-medio)", marginBottom: 5 }}>{titulo}</div>
      <div style={{ fontSize: 12, color: "var(--ink-tenue)", lineHeight: 1.55 }}>{texto}</div>
    </div>
  );
}
