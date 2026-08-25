"use client";

import { Cabecalho, Cartao, Nota, SemDado, brl, brlCurto, num, pct } from "./comum";
import type { Atribuicao, QualidadeGateway, ResumoDisparos, Disparo } from "@/core/rastreio";

/*
 * Saúde do rastreamento.
 *
 * A tela que existe porque o RRTrack é quem atribui, e não quem recebe atribuído.
 * Ela responde duas perguntas que nenhum painel de ROAS responde:
 *
 *   dá para confiar nos outros números? (quanto está atribuído por chave)
 *   o algoritmo está recebendo sinal ou migalha? (quantas chaves saem)
 *
 * Se a primeira estiver ruim, todo o resto do painel é ficção bem formatada.
 */

const TODAS_CHAVES = ["em", "ph", "fn", "ln", "ct", "st", "zp", "country", "external_id", "fbp", "fbc", "ip", "user_agent"];

export function Saude({
  periodo, atribuicao, gateways, disparos, ultimos,
}: {
  periodo: string;
  atribuicao: Atribuicao[];
  gateways: QualidadeGateway[];
  disparos: ResumoDisparos;
  ultimos: Disparo[];
}) {
  const totalVendas = atribuicao.reduce((s, a) => s + a.vendas, 0);
  const totalFat = atribuicao.reduce((s, a) => s + a.faturamentoCents, 0);
  const porChave = atribuicao.filter((a) => a.porChave).reduce((s, a) => s + a.faturamentoCents, 0);
  const confianca = totalFat ? (porChave / totalFat) * 100 : null;

  const COR: Record<string, string> = {
    click_id: "var(--positivo)",
    order_claim: "var(--acento)",
    fbp_match: "var(--alerta)",
    gateway_attribution: "#8A7A4A",
    unattributed: "#3E4E56",
  };

  if (totalVendas === 0 && disparos.entregues === 0 && disparos.falharam === 0) {
    return (
      <div style={{ minHeight: "100vh" }}>
        <Cabecalho titulo="Saúde do rastreamento" descricao="De onde veio a certeza de cada atribuição." periodo={periodo} />
        <div style={{ padding: 20 }}>
          <SemDado
            titulo="Nenhum disparo no período"
            texto="Esta tela se alimenta das vendas processadas e do que foi enviado às plataformas. Instale o script e aponte um webhook de gateway para ela ter o que mostrar."
          />
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <Cabecalho
        titulo="Saúde do rastreamento"
        descricao="De onde veio a certeza de cada atribuição, e quanta informação chegou em cada plataforma."
        periodo={periodo}
      />

      <div style={{ padding: "16px 20px 28px", display: "flex", flexDirection: "column", gap: 14 }}>

        {/* a pergunta que importa primeiro */}
        <div className="rr-cartoes" style={{
          display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10,
        }}>
          {[
            {
              rotulo: "Faturamento atribuído por chave",
              valor: pct(confianca),
              cor: confianca === null ? undefined
                : confianca >= 80 ? "var(--positivo)"
                : confianca >= 50 ? "var(--alerta)" : "var(--negativo)",
              nota: "o resto é inferência",
              destaque: true,
            },
            {
              rotulo: "Média de chaves por disparo",
              valor: disparos.mediaChaves === null ? "N/A" : disparos.mediaChaves.toFixed(1).replace(".", ","),
              nota: `de ${TODAS_CHAVES.length} possíveis`,
            },
            { rotulo: "Disparos entregues", valor: num(disparos.entregues), cor: "var(--positivo)" },
            {
              rotulo: "Disparos falhados", valor: num(disparos.falharam),
              cor: disparos.falharam ? "var(--negativo)" : undefined,
              nota: disparos.falharam ? "vendas gravadas, mas não enviadas" : undefined,
            },
          ].map((c) => (
            <div key={c.rotulo} style={{
              padding: "13px 15px", borderRadius: 8,
              background: c.destaque ? "var(--painel-alto)" : "var(--painel)",
              border: `1px solid ${c.destaque ? "var(--linha-forte)" : "var(--linha)"}`,
            }}>
              <div style={{
                fontSize: 10, letterSpacing: ".07em", textTransform: "uppercase",
                color: "var(--ink-tenue)", fontWeight: 600, marginBottom: 8,
              }}>{c.rotulo}</div>
              <div className="num" style={{
                fontSize: 20, fontWeight: 600, letterSpacing: "-.5px", color: c.cor ?? "var(--ink)",
              }}>{c.valor}</div>
              {c.nota && <div style={{ fontSize: 10.5, color: "var(--ink-tenue)", marginTop: 5 }}>{c.nota}</div>}
            </div>
          ))}
        </div>

        <div className="rr-paineis" style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 12, alignItems: "start" }}>

          <Cartao titulo="Como cada venda foi atribuída" descricao={`${num(totalVendas)} vendas no período`}>
            <div style={{ display: "flex", height: 9, borderRadius: 4, overflow: "hidden", marginBottom: 15 }}>
              {atribuicao.filter((a) => a.vendas > 0).map((a) => (
                <div key={a.metodo} title={`${a.rotulo}: ${a.vendas}`} style={{
                  width: `${(a.vendas / Math.max(1, totalVendas)) * 100}%`,
                  background: COR[a.metodo],
                }} />
              ))}
              {totalVendas === 0 && <div style={{ width: "100%", background: "var(--linha)" }} />}
            </div>

            {atribuicao.map((a) => (
              <div key={a.metodo} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "7px 0", borderBottom: "1px solid var(--linha)",
                opacity: a.vendas === 0 ? 0.45 : 1,
              }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: COR[a.metodo], flexShrink: 0 }} />
                <span className="num" style={{ fontSize: 11.5, color: "var(--ink-medio)", width: 150 }}>{a.rotulo}</span>
                <span style={{ fontSize: 11.5, color: "var(--ink-tenue)", flexGrow: 1 }}>{a.explicacao}</span>
                <span className="num" style={{ fontSize: 11.5, color: "var(--ink-fraco)" }}>{brlCurto(a.faturamentoCents)}</span>
                <span className="num" style={{ fontSize: 12.5, fontWeight: 600, minWidth: 34, textAlign: "right" }}>{num(a.vendas)}</span>
              </div>
            ))}

            <div style={{
              marginTop: 13, padding: "10px 12px", borderRadius: 5,
              background: "var(--painel-alto)", fontSize: 11.5,
              color: "var(--ink-fraco)", lineHeight: 1.5,
            }}>
              As duas primeiras linhas são <strong style={{ color: "var(--positivo)" }}>certeza</strong> —
              o identificador voltou. As outras são inferência. Vigie o crescimento de
              &ldquo;sem atribuição&rdquo;: subir de repente quer dizer que o carimbo no checkout parou
              de funcionar, e não que o tráfego mudou.
            </div>
          </Cartao>

          <Cartao titulo="Chaves enviadas por gateway" descricao="Média por disparo. Mais chaves, melhor a correspondência.">
            {gateways.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--ink-tenue)" }}>Nenhum disparo com gateway identificado.</div>
            ) : gateways.map((g) => (
              <div key={g.gateway} style={{ marginBottom: 15 }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 500 }}>{g.gateway}</span>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                    <span className="num" style={{
                      fontSize: 15, fontWeight: 600,
                      color: g.mediaChaves === null ? "var(--ink-tenue)"
                        : g.mediaChaves >= 9 ? "var(--positivo)"
                        : g.mediaChaves >= 6 ? "var(--acento)" : "var(--alerta)",
                    }}>{g.mediaChaves === null ? "—" : g.mediaChaves.toFixed(1).replace(".", ",")}</span>
                    <span className="num" style={{ fontSize: 10.5, color: "var(--ink-tenue)" }}>/{TODAS_CHAVES.length}</span>
                  </div>
                </div>
                <div style={{ height: 6, borderRadius: 3, background: "var(--linha)", overflow: "hidden" }}>
                  <div style={{
                    height: "100%", borderRadius: 3, background: "var(--acento)",
                    width: `${((g.mediaChaves ?? 0) / TODAS_CHAVES.length) * 100}%`,
                  }} />
                </div>
                <div className="num" style={{ fontSize: 10, color: "var(--ink-tenue)", marginTop: 4 }}>
                  {num(g.disparos)} disparos
                </div>
              </div>
            ))}
          </Cartao>
        </div>

        {/* últimos disparos */}
        <Cartao titulo="Últimos disparos" descricao="O que saiu para as plataformas, com as chaves que foram junto.">
          {ultimos.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--ink-tenue)" }}>Nada ainda.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <div style={{ minWidth: 900 }}>
                <div style={{
                  display: "grid", gridTemplateColumns: "0.7fr 0.9fr 0.8fr 0.9fr 3fr 0.7fr",
                  padding: "8px 0", borderBottom: "1px solid var(--linha-forte)",
                  fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase",
                  color: "var(--ink-tenue)", fontWeight: 600,
                }}>
                  <div>Quando</div><div>Evento</div><div>Gateway</div><div>Valor</div>
                  <div>Chaves enviadas</div><div style={{ textAlign: "right" }}>Estado</div>
                </div>

                {ultimos.map((d) => (
                  <div key={d.id} style={{
                    display: "grid", gridTemplateColumns: "0.7fr 0.9fr 0.8fr 0.9fr 3fr 0.7fr",
                    padding: "9px 0", borderBottom: "1px solid var(--linha)",
                    alignItems: "center", fontSize: 11.5,
                  }}>
                    <div className="num" style={{ color: "var(--ink-tenue)" }}>{d.quando}</div>
                    <div className="num" style={{ color: "var(--ink-medio)" }}>{d.evento}</div>
                    <div style={{ color: "var(--ink-fraco)" }}>{d.gateway ?? "—"}</div>
                    <div className="num">{d.valorCents === null ? "—" : brl(d.valorCents)}</div>
                    <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                      {TODAS_CHAVES.map((k) => {
                        const tem = d.chaves.includes(k);
                        return (
                          <span key={k} className="num" style={{
                            fontSize: 9, padding: "1px 4px", borderRadius: 2,
                            background: tem ? "var(--positivo-fundo)" : "var(--linha)",
                            color: tem ? "var(--positivo)" : "#3E4E56",
                          }}>{k}</span>
                        );
                      })}
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <span style={{
                        fontSize: 11,
                        color: d.estado === "sent" ? "var(--positivo)"
                          : d.estado === "failed" ? "var(--negativo)" : "var(--ink-tenue)",
                      }} title={d.erro ?? undefined}>
                        {d.estado === "sent" ? "entregue" : d.estado === "failed" ? "falhou" : d.estado}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Cartao>

        <Nota>
          As chaves apagadas são as que <em>não</em> foram enviadas naquele disparo. Endereço
          e telefone dependem do que o gateway manda no webhook, e nem todos mandam — é por isso
          que a média difere entre eles.
        </Nota>
      </div>
    </div>
  );
}
