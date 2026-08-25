"use client";

import { useEffect, useState } from "react";
import type { AoVivo } from "@/core/aovivo";
import { nomeDaRegiao, nomeDoPais } from "@/core/aovivo";

/*
 * Quem está no site agora, no topo do Resumo.
 *
 * É a única parte do painel que não olha para trás, e por isso ignora o filtro
 * de período — agora é agora. Fica acima de tudo porque é o que se abre o
 * painel para ver primeiro quando a campanha acabou de subir.
 *
 * Busca os próprios números em vez de esperar o refresh geral da tela. O resto
 * do Resumo são agregações pesadas que não mudam em dez segundos; recalculá-las
 * nesse ritmo seria gastar consulta à toa. Aqui, meio minuto de atraso se nota:
 * quem abre o site e olha o painel espera se ver.
 */

const INTERVALO_MS = 10000;

export function SecaoAoVivo({ dados }: { dados: AoVivo }) {
  /*
   * Começa com o que o servidor renderizou, para a seção não nascer vazia e
   * piscar no primeiro carregamento.
   */
  const [vivos, setVivos] = useState(dados);

  /* Dado novo do servidor manda: veio de um refresh geral da tela. */
  useEffect(() => { setVivos(dados); }, [dados]);

  useEffect(() => {
    let cancelado = false;

    async function buscar() {
      /* Aba escondida não consulta: painel aberto em segundo plano a semana
         inteira faria milhares de chamadas para ninguém ler. */
      if (document.visibilityState !== "visible") return;
      try {
        const r = await fetch("/api/ao-vivo", { cache: "no-store" });
        if (!r.ok || cancelado) return;
        setVivos(await r.json());
      } catch { /* rede caiu: mantém o último número em vez de zerar */ }
    }

    const t = setInterval(buscar, INTERVALO_MS);
    /* Voltar para a aba atualiza na hora, sem esperar o ciclo. */
    const aoVoltar = () => { if (document.visibilityState === "visible") buscar(); };
    document.addEventListener("visibilitychange", aoVoltar);

    return () => {
      cancelado = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", aoVoltar);
    };
  }, []);

  const { agora, ultimaHora, locais, semLocal } = vivos;
  const vivo = agora > 0;
  const maior = locais[0]?.sessoes ?? 1;

  return (
    <div style={{
      background: "var(--painel)", border: "1px solid var(--linha)",
      borderRadius: 8, overflow: "hidden",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 9,
        padding: "12px 16px", borderBottom: "1px solid var(--linha)",
      }}>
        {/*
          O ponto pulsa só quando há gente. Um indicador que pisca com zero
          visitante vira enfeite, e a pessoa para de olhar para ele.
        */}
        <span style={{
          width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
          background: vivo ? "var(--positivo)" : "var(--linha-forte)",
          boxShadow: vivo ? "0 0 0 3px var(--positivo-fundo)" : "none",
          animation: vivo ? "rr-pulsa 2s ease-in-out infinite" : "none",
        }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Ao vivo</span>
        <span style={{ fontSize: 11, color: "var(--ink-tenue)", marginLeft: "auto" }}>
          a cada 10s
        </span>
      </div>

      <div className="rr-aovivo" style={{
        display: "grid", gridTemplateColumns: "auto 1fr", gap: 20,
        padding: 16, alignItems: "start",
      }}>
        {/* o número */}
        <div style={{ minWidth: 130 }}>
          <div style={{
            fontSize: 10, letterSpacing: ".07em", textTransform: "uppercase",
            color: "var(--ink-tenue)", fontWeight: 600, marginBottom: 4,
          }}>Visitantes agora</div>
          <div className="num" style={{
            fontSize: 34, fontWeight: 700, lineHeight: 1, letterSpacing: "-1px",
            color: vivo ? "var(--ink)" : "var(--ink-tenue)",
          }}>{agora}</div>
          <div style={{ fontSize: 11, color: "var(--ink-tenue)", marginTop: 7, lineHeight: 1.45 }}>
            {ultimaHora > 0
              ? <><span className="num">{ultimaHora}</span> na última hora</>
              : "ninguém na última hora"}
          </div>
        </div>

        {/* de onde vêm */}
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: 10, letterSpacing: ".07em", textTransform: "uppercase",
            color: "var(--ink-tenue)", fontWeight: 600, marginBottom: 9,
          }}>Sessões por local · última hora</div>

          {locais.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--ink-tenue)", lineHeight: 1.5 }}>
              {semLocal > 0
                ? <>Houve <span className="num">{semLocal}</span> sessão(ões), mas sem origem identificada.</>
                : "Nenhuma sessão na última hora."}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {locais.map((l, i) => {
                const regiao = nomeDaRegiao(l.pais, l.regiao);
                return (
                  <div key={i}>
                    <div style={{
                      display: "flex", alignItems: "baseline", gap: 8,
                      fontSize: 11.5, marginBottom: 3,
                    }}>
                      <span style={{
                        color: "var(--ink-medio)", overflow: "hidden",
                        textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>
                        {[nomeDoPais(l.pais), regiao, l.cidade].filter(Boolean).join(" · ")}
                      </span>
                      <span className="num" style={{
                        marginLeft: "auto", color: "var(--ink-fraco)", fontWeight: 600,
                      }}>{l.sessoes}</span>
                    </div>
                    {/*
                      A barra é relativa ao maior, não ao total: com uma cidade
                      só, uma barra proporcional ao total ocuparia a linha
                      inteira e não diria nada. Assim ela sempre compara.
                    */}
                    <div style={{ height: 4, borderRadius: 2, background: "var(--linha)" }}>
                      <div style={{
                        height: "100%", borderRadius: 2, background: "var(--acento)",
                        width: `${Math.max((l.sessoes / maior) * 100, 4)}%`,
                      }} />
                    </div>
                  </div>
                );
              })}
              {semLocal > 0 && (
                <div style={{ fontSize: 11, color: "var(--ink-tenue)", marginTop: 2 }}>
                  mais <span className="num">{semLocal}</span> sem origem identificada
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
