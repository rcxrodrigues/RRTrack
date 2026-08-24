"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Cabecalho, Cartao, Nota, SemDado, brl, num, pct } from "./comum";
import type { LinhaUtm } from "@/core/rastreio";

/*
 * Origem do tráfego, lida das sessões de clique.
 *
 * Diferente das telas de plataforma, esta NÃO depende de conta de anúncio
 * conectada: ela mostra de onde as pessoas vieram e quanto compraram, sem
 * precisar saber quanto custou. É a metade do quadro que funciona antes de
 * qualquer integração com plataforma de anúncio.
 */

const NIVEIS = [
  { id: "fonte", rotulo: "Por fonte", coluna: "Fonte / meio" },
  { id: "campanha", rotulo: "Por campanha", coluna: "Campanha" },
  { id: "conteudo", rotulo: "Por criativo", coluna: "Criativo" },
] as const;

export function Utms({
  periodo, agrupar, linhas,
}: {
  periodo: string;
  agrupar: "fonte" | "campanha" | "conteudo";
  linhas: LinhaUtm[];
}) {
  const router = useRouter();
  const caminho = usePathname();
  const params = useSearchParams();

  function ir(nivel: string) {
    const p = new URLSearchParams(params.toString());
    p.set("agrupar", nivel);
    router.push(`${caminho}?${p.toString()}`);
  }

  const total = linhas.reduce(
    (t, l) => ({
      sessoes: t.sessoes + l.sessoes,
      vendas: t.vendas + l.vendas,
      faturamento: t.faturamento + l.faturamentoCents,
    }),
    { sessoes: 0, vendas: 0, faturamento: 0 },
  );

  const coluna = NIVEIS.find((n) => n.id === agrupar)!.coluna;
  const grade = "2.2fr 1.6fr 0.9fr 0.8fr 1.1fr 0.9fr";

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <Cabecalho
        titulo="UTMs"
        descricao="De onde o tráfego veio e quanto cada origem comprou. Não depende de conta de anúncio conectada."
        periodo={periodo}
        extra={
          <div style={{
            display: "flex", gap: 2, padding: 3, borderRadius: 6,
            border: "1px solid var(--linha-forte)", background: "var(--painel-alto)",
          }}>
            {NIVEIS.map((n) => (
              <button key={n.id} onClick={() => ir(n.id)} style={{
                padding: "4px 11px", borderRadius: 4, border: "none", fontSize: 11.5, fontWeight: 500,
                background: agrupar === n.id ? "var(--linha-forte)" : "transparent",
                color: agrupar === n.id ? "var(--ink)" : "var(--ink-fraco)",
              }}>{n.rotulo}</button>
            ))}
          </div>
        }
      />

      <div style={{ padding: "16px 20px 28px", display: "flex", flexDirection: "column", gap: 14 }}>
        {linhas.length === 0 ? (
          <SemDado
            titulo="Nenhuma sessão no período"
            texto="As sessões nascem quando alguém abre uma página com o script instalado. Cole o trecho de Integrações no seu site e volte aqui."
          />
        ) : (
          <>
            <Cartao>
              <div style={{ overflowX: "auto" }}>
                <div style={{ minWidth: 820 }}>
                  <div style={{
                    display: "grid", gridTemplateColumns: grade,
                    padding: "8px 0", borderBottom: "1px solid var(--linha-forte)",
                    fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase",
                    color: "var(--ink-tenue)", fontWeight: 600,
                  }}>
                    <div>{coluna}</div>
                    <div>{agrupar === "conteudo" ? "Campanha" : "Meio"}</div>
                    <div style={{ textAlign: "right" }}>Sessões</div>
                    <div style={{ textAlign: "right" }}>Vendas</div>
                    <div style={{ textAlign: "right" }}>Faturamento</div>
                    <div style={{ textAlign: "right" }}>Conversão</div>
                  </div>

                  {linhas.map((l, i) => (
                    <div key={i} style={{
                      display: "grid", gridTemplateColumns: grade,
                      padding: "9px 0", borderBottom: "1px solid var(--linha)",
                      alignItems: "center", fontSize: 12,
                    }}>
                      <div className="num" style={{
                        fontWeight: 500, overflow: "hidden",
                        textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>
                        {agrupar === "fonte" ? l.fonte
                          : agrupar === "campanha" ? (l.campanha || "(sem campanha)")
                          : (l.conteudo || "(sem criativo)")}
                      </div>
                      <div className="num" style={{
                        color: "var(--ink-tenue)", fontSize: 11,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>
                        {agrupar === "conteudo" ? (l.campanha || "—") : (l.meio || "—")}
                      </div>
                      <div className="num" style={{ textAlign: "right", color: "var(--ink-fraco)" }}>{num(l.sessoes)}</div>
                      <div className="num" style={{ textAlign: "right" }}>{num(l.vendas)}</div>
                      <div className="num" style={{ textAlign: "right", fontWeight: 500 }}>{brl(l.faturamentoCents)}</div>
                      <div className="num" style={{
                        textAlign: "right", fontWeight: 600,
                        color: l.taxaConversao === null ? "var(--ink-tenue)"
                          : l.taxaConversao >= 3 ? "var(--positivo)"
                          : l.taxaConversao >= 1 ? "var(--acento)" : "var(--ink-fraco)",
                      }}>{pct(l.taxaConversao, 2)}</div>
                    </div>
                  ))}

                  <div style={{
                    display: "grid", gridTemplateColumns: grade,
                    padding: "10px 0", borderTop: "1px solid var(--linha-forte)",
                    alignItems: "center", fontSize: 12, fontWeight: 600,
                  }}>
                    <div style={{ color: "var(--ink-fraco)" }}>{linhas.length} origens</div>
                    <div />
                    <div className="num" style={{ textAlign: "right" }}>{num(total.sessoes)}</div>
                    <div className="num" style={{ textAlign: "right" }}>{num(total.vendas)}</div>
                    <div className="num" style={{ textAlign: "right" }}>{brl(total.faturamento)}</div>
                    <div className="num" style={{ textAlign: "right", color: "var(--acento)" }}>
                      {pct(total.sessoes ? (total.vendas / total.sessoes) * 100 : null, 2)}
                    </div>
                  </div>
                </div>
              </div>
            </Cartao>

            <Nota>
              Sessão sem UTM nenhuma aparece como <span className="num">(direto)</span> — é
              tráfego que chegou sem marcação, e não necessariamente digitando o endereço:
              link de aplicativo de mensagem e clique sem parâmetro caem aí também. Os códigos
              para marcar seus anúncios estão em <strong style={{ color: "var(--ink-fraco)" }}>Integrações → UTMs</strong>.
            </Nota>
          </>
        )}
      </div>
    </div>
  );
}
