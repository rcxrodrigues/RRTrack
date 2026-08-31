"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { AutoAtualiza } from "./auto-atualiza";

/*
 * Peças compartilhadas pelas telas do painel.
 *
 * A regra de formatação que vale em todas: `null` vira "N/A", nunca "0".
 * Zero é um resultado; N/A é a ausência de resultado. Confundir os dois faz o
 * painel afirmar coisas que não sabe — e a decisão de escalar ou matar campanha
 * sai daí.
 */


/*
 * Dinheiro NÃO se formata aqui.
 *
 * `brl`, `brlCurto` e `brlOuNa` viviam neste arquivo e escreviam "R$" fixo.
 * Numa loja em libra isso mostrava "R$ 1.234,56" para £1.234,56 — número
 * errado com cara de certo. Agora vem de `useDinheiro()`, em ./moeda, que lê
 * a moeda da loja do contexto.
 */

export const num = (n: number) => n.toLocaleString("pt-BR");

/*
 * Porcentagem já em pontos percentuais: 27,2 vira "27,2%".
 *
 * NÃO multiplica por 100. Quem calcula a taxa é que faz isso, e todo o
 * src/core/resumo.ts e src/core/rastreio.ts já entregam assim. Passar uma
 * proporção crua aqui não dá erro nenhum — só mostra um número cem vezes
 * menor, que foi exatamente o que aconteceu com a margem.
 */
export const pct = (v: number | null, casas = 1) =>
  v === null ? "N/A" : v.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas }) + "%";

export const razao = (v: number | null) =>
  v === null ? "N/A" : v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });


export const corValor = (v: number) =>
  v > 0 ? "var(--positivo)" : v < 0 ? "var(--negativo)" : "var(--ink-medio)";

/*
 * A ordem é a da Utmify, de propósito.
 *
 * O lojista já lê esta lista lá todo dia; procurar "Ontem" num lugar diferente
 * é atrito que não rende nada. As de 14 e 30 dias entram no meio porque já
 * existiam aqui e estavam em uso — tirá-las para copiar a lista ao pé da letra
 * seria perder função para ganhar semelhança.
 */
export const PERIODOS = [
  { id: "max", rotulo: "Máximo" },
  { id: "hoje", rotulo: "Hoje" },
  { id: "ontem", rotulo: "Ontem" },
  { id: "7d", rotulo: "Últimos 7 dias" },
  { id: "14d", rotulo: "Últimos 14 dias" },
  { id: "30d", rotulo: "Últimos 30 dias" },
  { id: "mes", rotulo: "Esse mês" },
  { id: "mespassado", rotulo: "Mês passado" },
  { id: "personalizado", rotulo: "Personalizado" },
];

/*
 * Barra de topo com escolha de período, e título opcional.
 *
 * Sem título a barra vira só os controles, alinhados à direita. É o caso da
 * tela inicial: ali "Resumo" repete o que a navegação já diz, e a descrição
 * explica algo que os próprios cartões logo abaixo mostram melhor.
 */
export function Cabecalho({
  titulo, descricao, periodo, extra,
}: {
  titulo?: string;
  descricao?: string;
  periodo: string;
  extra?: React.ReactNode;
}) {
  const router = useRouter();
  const caminho = usePathname();
  const params = useSearchParams();

  function trocar(id: string) {
    const p = new URLSearchParams(params.toString());
    p.set("periodo", id);
    /*
     * Sair do personalizado limpa as datas. Deixá-las na URL faria elas
     * voltarem sozinhas na próxima vez que alguém escolhesse "Personalizado",
     * mostrando um intervalo que a pessoa não pediu.
     */
    if (id !== "personalizado") { p.delete("de"); p.delete("ate"); }
    router.push(`${caminho}?${p.toString()}`);
  }

  function trocarData(qual: "de" | "ate", valor: string) {
    const p = new URLSearchParams(params.toString());
    p.set("periodo", "personalizado");
    p.set(qual, valor);
    router.push(`${caminho}?${p.toString()}`);
  }

  return (
    <div className="rr-conteudo" style={{
      padding: "16px 20px", borderBottom: "1px solid var(--linha)",
      background: "var(--painel)", display: "flex",
      alignItems: "flex-start", justifyContent: "space-between", gap: 20,
    }}>
      {titulo ? (
        <div>
          <h1 style={{ fontSize: 17, fontWeight: 700, margin: 0, letterSpacing: "-.2px" }}>{titulo}</h1>
          {descricao && (
            <p style={{ fontSize: 12, color: "var(--ink-tenue)", margin: "3px 0 0", maxWidth: 620 }}>{descricao}</p>
          )}
        </div>
      ) : (
        /* Empurra os controles para a direita sem deixar buraco na esquerda. */
        <div />
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
        <AutoAtualiza />
        {extra}
        {/*
          Menu, e não a fileira de botões de antes.
          
          Com quatro opções a fileira cabia; com nove ela empurraria o resto da
          barra para fora da tela no celular. E o menu é o formato que o
          lojista já conhece de outras ferramentas.
        */}
        {periodo === "personalizado" && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="date" value={params.get("de") ?? ""}
              onChange={(e) => trocarData("de", e.target.value)}
              style={{ width: "auto", fontSize: 11.5, padding: "4px 7px" }} />
            <span style={{ fontSize: 11.5, color: "var(--ink-tenue)" }}>até</span>
            <input type="date" value={params.get("ate") ?? ""}
              onChange={(e) => trocarData("ate", e.target.value)}
              style={{ width: "auto", fontSize: 11.5, padding: "4px 7px" }} />
          </div>
        )}
        <select value={periodo} onChange={(e) => trocar(e.target.value)}
          style={{ width: "auto", fontSize: 11.5, padding: "5px 9px" }}>
          {PERIODOS.map((p) => (
            <option key={p.id} value={p.id}>{p.rotulo}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function Cartao({ titulo, descricao, children, largo }: {
  titulo?: string; descricao?: string; children: React.ReactNode; largo?: boolean;
}) {
  return (
    <div style={{
      background: "var(--painel)", border: "1px solid var(--linha)",
      borderRadius: 8, overflow: "hidden",
      gridColumn: largo ? "1 / -1" : undefined,
    }}>
      {titulo && (
        <div style={{ padding: "13px 17px 12px", borderBottom: "1px solid var(--linha)" }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{titulo}</div>
          {descricao && (
            <div style={{ fontSize: 11.5, color: "var(--ink-tenue)", marginTop: 2 }}>{descricao}</div>
          )}
        </div>
      )}
      <div style={{ padding: 17 }}>{children}</div>
    </div>
  );
}

/** Aviso honesto de tela sem dado, dizendo o que falta para haver dado. */
export function SemDado({ titulo, texto }: { titulo: string; texto: string }) {
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

export function Nota({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 7,
      fontSize: 11.5, color: "var(--ink-tenue)", lineHeight: 1.5, maxWidth: 860,
    }}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ flexShrink: 0, marginTop: 2 }}>
        <circle cx="8" cy="8" r="6" /><path d="M8 5v3.5M8 11h.01" />
      </svg>
      <span>{children}</span>
    </div>
  );
}
