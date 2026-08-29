"use client";

import { useDinheiro } from "./moeda";

import { Cabecalho, Cartao, Nota, corValor, num, pct, razao } from "./comum";
import { SecaoAoVivo } from "./ao-vivo";
import type { AoVivo } from "@/core/aovivo";
import { nomeDaRegiao, nomeDoPais } from "@/core/aovivo";
import type { Indicadores, EtapaFunil, Celula, Origem, Aprovacao, Regiao } from "@/core/resumo";

/*
 * O Resumo.
 *
 * A ordem dos indicadores não é estética: começa pelo que decide (lucro e
 * ROAS), depois o que explica (faturamento, gasto, vendas) e por último o que
 * corrige (pendentes, taxas, reembolsos). Quem abre o painel de manhã quer
 * saber se ontem sobrou dinheiro, não quantas impressões houve.
 */

const DIAS = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"];

export function Resumo({
  periodo, temGasto, ind, funil, horario, origens, pagamento, regioes, aoVivo,
}: {
  periodo: string;
  temGasto: boolean;
  ind: Indicadores;
  funil: EtapaFunil[];
  horario: Celula[];
  origens: Origem[];
  pagamento: Aprovacao[];
  regioes: Regiao[];
  aoVivo: AoVivo;
}) {
  const dinheiro = useDinheiro();
  const vazio = ind.vendasAprovadas === 0 && funil[0]!.valor === 0;

  const cartoes: Array<{
    rotulo: string; valor: string; cor?: string; nota?: string; destaque?: boolean; ausente?: boolean;
    /* Nota que e aviso, e nao rodape: sai na cor de alerta em vez de apagada. */
    notaAlerta?: boolean;
  }> = [
    {
      rotulo: "Lucro",
      valor: temGasto ? dinheiro(ind.lucroCents) : dinheiro(ind.faturamentoLiquidoCents - ind.custoProdutoCents),
      cor: corValor(temGasto ? ind.lucroCents : ind.faturamentoLiquidoCents - ind.custoProdutoCents),
      destaque: true,
      nota: temGasto ? "líquido − custo − anúncio" : "sem o gasto de anúncio ainda",
    },
    { rotulo: "ROAS", valor: razao(ind.roas), ausente: !temGasto, nota: temGasto ? undefined : "precisa do gasto" },
    { rotulo: "Faturamento líquido", valor: dinheiro(ind.faturamentoLiquidoCents), nota: "já sem taxas e reembolsos" },
    /*
     * Quando ha gasto em outra moeda, o numero deste cartao esta INCOMPLETO —
     * e ROAS, CPA e Lucro saem todos dele. A nota nao e detalhe: sem ela, o
     * lucro aparece maior do que e e ninguem tem como desconfiar.
     */
    {
      rotulo: "Gasto com anúncios",
      valor: temGasto ? dinheiro(ind.gastoCents) : "N/A",
      ausente: !temGasto,
      nota: ind.moedasIgnoradas.length
        ? `fora: gasto em ${ind.moedasIgnoradas.join(", ")}`
        : temGasto ? undefined : "conecte a conta em Integrações",
      notaAlerta: ind.moedasIgnoradas.length > 0,
    },

    { rotulo: "Faturamento bruto", valor: dinheiro(ind.faturamentoBrutoCents) },
    { rotulo: "Vendas aprovadas", valor: num(ind.vendasAprovadas) },
    { rotulo: "Ticket médio", valor: dinheiro(ind.ticketMedioCents) },
    { rotulo: "CPA", valor: dinheiro(ind.cpaCents), ausente: !temGasto },

    {
      rotulo: "Vendas pendentes", valor: num(ind.vendasPendentes),
      cor: ind.vendasPendentes ? "var(--alerta)" : undefined,
      nota: ind.pendenteCents ? dinheiro(ind.pendenteCents, true) + " aguardando" : undefined,
    },
    { rotulo: "Margem", valor: pct(ind.margem), cor: ind.margem === null ? undefined : corValor(ind.margem) },
    { rotulo: "Taxas de gateway", valor: dinheiro(ind.taxasCents) },
    {
      rotulo: "Reembolsos", valor: dinheiro(ind.reembolsosCents),
      cor: ind.reembolsosCents ? "var(--negativo)" : undefined,
      nota: ind.reembolsadas ? num(ind.reembolsadas) + " vendas" : undefined,
    },
  ];

  /* Escala do mapa de calor, calculada sobre o próprio período. */
  const maxHora = Math.max(1, ...horario.map((c) => c.vendas));
  const tons = ["#141F26", "#123038", "#0F4A55", "#1E7F8C", "#45C4D0"];
  const tom = (v: number) => (v === 0 ? tons[0] : tons[Math.min(4, Math.ceil((v / maxHora) * 4))]);
  const mapa = new Map(horario.map((c) => [`${c.dia}:${c.hora}`, c]));
  const pico = horario.reduce<Celula | null>((a, c) => (!a || c.vendas > a.vendas ? c : a), null);

  const maxFonte = Math.max(1, ...origens.map((o) => o.faturamentoCents));
  const maxRegiao = Math.max(1, ...regioes.map((r) => r.sessoes));
  const topoFunil = Math.max(1, funil[0]!.valor);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      {/* Sem título: a navegação já diz onde se está, e os cartões abaixo
          explicam melhor que uma frase o que a tela mostra. */}
      <Cabecalho periodo={periodo} />

      <div className="rr-conteudo" style={{ padding: "16px 20px 28px", display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Acima de tudo: é o que se abre o painel para ver quando a campanha
            acabou de subir, e é a única coisa aqui que não olha para trás. */}
        <SecaoAoVivo dados={aoVivo} />

        {vazio && (
          <div style={{
            padding: "14px 17px", borderRadius: 8, maxWidth: 780,
            background: "var(--alerta-fundo)", border: "1px solid var(--alerta)",
            fontSize: 12.5, color: "var(--ink-medio)", lineHeight: 1.55,
          }}>
            <strong style={{ color: "var(--alerta)" }}>Nenhum dado no período.</strong>{" "}
            O painel só mostra o que passou pelo rastreamento — instale o script do site
            e aponte um webhook de gateway em Integrações. Enquanto isso, tudo aqui fica em zero,
            e zero aqui significa ausência de dado, não ausência de venda.
          </div>
        )}

        {/* indicadores */}
        <div className="rr-cartoes" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
          {cartoes.map((c) => (
            <div key={c.rotulo} style={{
              padding: "13px 15px", borderRadius: 8,
              background: c.destaque ? "var(--positivo-fundo)" : "var(--painel)",
              border: `1px solid ${c.destaque ? "#1C3A31" : "var(--linha)"}`,
              opacity: c.ausente ? 0.55 : 1,
            }}>
              <div style={{
                fontSize: 10, letterSpacing: ".07em", textTransform: "uppercase",
                color: "var(--ink-tenue)", fontWeight: 600, marginBottom: 8,
              }}>{c.rotulo}</div>
              <div className="num" style={{
                fontSize: 20, fontWeight: 600, letterSpacing: "-.5px",
                color: c.cor ?? "var(--ink)",
              }}>{c.valor}</div>
              {c.nota && (
                <div style={{
                  fontSize: 10.5, marginTop: 5,
                  color: c.notaAlerta ? "var(--alerta)" : "var(--ink-tenue)",
                  fontWeight: c.notaAlerta ? 600 : undefined,
                }}>{c.nota}</div>
              )}
            </div>
          ))}
        </div>

        {/* funil */}
        <Cartao titulo="Funil de conversão" descricao="Visitantes únicos em cada etapa — não eventos, para quem recarrega a página não virar visitante novo.">
          <div className="rr-funil" style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }}>
            {funil.map((e, i) => (
              <div key={e.rotulo} style={{
                padding: "0 16px",
                borderLeft: i === 0 ? "none" : "1px solid var(--linha)",
              }}>
                <div style={{ fontSize: 11, color: "var(--ink-fraco)", fontWeight: 500, marginBottom: 9 }}>{e.rotulo}</div>
                <div className="num" style={{
                  fontSize: 22, fontWeight: 600, letterSpacing: "-.5px",
                  color: i === funil.length - 1 ? "var(--positivo)" : "var(--ink)",
                }}>{num(e.valor)}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 8 }}>
                  <div style={{ flexGrow: 1, height: 5, borderRadius: 3, background: "var(--linha)", overflow: "hidden" }}>
                    <div style={{
                      height: "100%", width: `${(e.valor / topoFunil) * 100}%`, borderRadius: 3,
                      background: i === funil.length - 1 ? "var(--positivo)" : "var(--acento)",
                    }} />
                  </div>
                  <span className="num" style={{
                    fontSize: 10.5, fontWeight: 600, minWidth: 42, textAlign: "right",
                    color: e.taxa === null ? "var(--ink-tenue)"
                      : e.taxa >= 50 ? "var(--positivo)"
                      : e.taxa >= 25 ? "var(--alerta)" : "var(--negativo)",
                  }}>{e.taxa === null ? "—" : pct(e.taxa)}</span>
                </div>
                {e.perda > 0 && (
                  <div className="num" style={{ fontSize: 10, color: "var(--ink-tenue)", marginTop: 5 }}>
                    −{num(e.perda)} saíram aqui
                  </div>
                )}
                {/*
                  Etapa com mais gente que a anterior não tem taxa de passagem.
                  Em vez de mostrar 130% de conversão, diz o que de fato houve:
                  chegou venda de quem o navegador nunca viu.
                */}
                {e.excedente > 0 && (
                  <div style={{
                    fontSize: 10, color: "var(--alerta)", marginTop: 5, lineHeight: 1.45,
                  }}>
                    +<span className="num">{num(e.excedente)}</span> sem passar pela
                    etapa anterior — venda sem sessão registrada
                  </div>
                )}
              </div>
            ))}
          </div>
        </Cartao>

        <div className="rr-paineis" style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr", gap: 12, alignItems: "start" }}>

          {/* horário */}
          <Cartao
            titulo="Vendas por horário"
            descricao={pico && pico.vendas > 0
              ? `Pico em ${DIAS[pico.dia]} às ${String(pico.hora).padStart(2, "0")}h`
              : "Quando o dinheiro entra, no fuso da loja"}
          >
            <div style={{ display: "flex", gap: 6 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingTop: 14 }}>
                {DIAS.map((d) => (
                  <div key={d} className="num" style={{
                    height: 16, display: "flex", alignItems: "center",
                    fontSize: 9.5, color: "var(--ink-tenue)", width: 22,
                  }}>{d}</div>
                ))}
              </div>
              <div style={{ flexGrow: 1, minWidth: 0 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(24, minmax(0, 1fr))", gap: 2, marginBottom: 4 }}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <div key={h} className="num" style={{ fontSize: 8.5, color: "#3E4E56", textAlign: "center" }}>
                      {h % 3 === 0 ? String(h).padStart(2, "0") : ""}
                    </div>
                  ))}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(24, minmax(0, 1fr))", gap: 2 }}>
                  {DIAS.map((_, d) => Array.from({ length: 24 }, (_, h) => {
                    const c = mapa.get(`${d}:${h}`);
                    return (
                      <div key={`${d}-${h}`}
                        title={c ? `${DIAS[d]} ${h}h — ${c.vendas} venda(s), ${dinheiro(c.valorCents)}` : undefined}
                        style={{ height: 16, borderRadius: 2, background: tom(c?.vendas ?? 0) }} />
                    );
                  }))}
                </div>
              </div>
            </div>
          </Cartao>

          {/* origem */}
          <Cartao titulo="Origem do tráfego" descricao="Faturamento por fonte">
            {origens.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--ink-tenue)" }}>Nenhuma sessão no período.</div>
            ) : origens.slice(0, 6).map((o) => (
              <div key={o.fonte} style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 5 }}>
                  <span className="num" style={{
                    fontSize: 11.5, color: "var(--ink-medio)", overflow: "hidden",
                    textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 150,
                  }}>{o.fonte}</span>
                  <span className="num" style={{ fontSize: 11.5, fontWeight: 600 }}>{dinheiro(o.faturamentoCents, true)}</span>
                </div>
                <div style={{ height: 5, borderRadius: 3, background: "var(--linha)", overflow: "hidden" }}>
                  <div style={{
                    height: "100%", borderRadius: 3, background: "var(--acento)",
                    width: `${(o.faturamentoCents / maxFonte) * 100}%`,
                  }} />
                </div>
                <div className="num" style={{ fontSize: 10, color: "var(--ink-tenue)", marginTop: 3 }}>
                  {num(o.sessoes)} sessões · {num(o.vendas)} vendas
                </div>
              </div>
            ))}
          </Cartao>

          {/* aprovação */}
          <Cartao titulo="Taxa de aprovação" descricao="Quanto de cada método vira dinheiro">
            {pagamento.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--ink-tenue)" }}>Nenhuma venda no período.</div>
            ) : pagamento.map((m) => (
              <div key={m.metodo} style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 500 }}>{m.metodo}</span>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                    <span className="num" style={{
                      fontSize: 13, fontWeight: 600,
                      color: m.taxa === null ? "var(--ink-tenue)"
                        : m.taxa >= 80 ? "var(--positivo)"
                        : m.taxa >= 50 ? "var(--acento)" : "var(--alerta)",
                    }}>{pct(m.taxa)}</span>
                    <span className="num" style={{ fontSize: 10, color: "var(--ink-tenue)" }}>
                      {m.aprovadas}/{m.total}
                    </span>
                  </div>
                </div>
                <div style={{ height: 5, borderRadius: 3, background: "var(--linha)", overflow: "hidden" }}>
                  <div style={{
                    height: "100%", borderRadius: 3, background: "var(--acento)",
                    width: `${m.taxa ?? 0}%`,
                  }} />
                </div>
              </div>
            ))}
          </Cartao>
        </div>

        {/*
          De onde vieram os acessos no PERÍODO escolhido.

          A seção "ao vivo" lá em cima responde outra pergunta — quem está no
          site agora — e por isso só olha a última hora e corta em doze linhas.
          No primeiro dia de tráfego isso confundiu: dezoito estados acessaram
          e a seção mostrava três, porque os outros quinze tinham entrado antes
          da última hora. Este quadro respeita o filtro de data e mostra todos.
        */}
        <Cartao largo titulo="Sessões por estado"
          descricao="De onde veio o tráfego no período — respeita o filtro de data, ao contrário da seção ao vivo">
          {regioes.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--ink-tenue)" }}>Nenhuma sessão no período.</div>
          ) : (
            <div style={{
              display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
              gap: "0 22px",
            }}>
              {regioes.map((r, i) => {
                const uf = nomeDaRegiao(r.pais, r.regiao);
                const nome = [nomeDoPais(r.pais), uf].filter(Boolean).join(" · ")
                  || "origem não identificada";
                return (
                  <div key={i} style={{ marginBottom: 11 }}>
                    <div style={{
                      display: "flex", alignItems: "baseline",
                      justifyContent: "space-between", gap: 8, marginBottom: 4,
                    }}>
                      <span style={{
                        fontSize: 11.5, color: "var(--ink-medio)", overflow: "hidden",
                        textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>{nome}</span>
                      <span className="num" style={{ fontSize: 11.5, fontWeight: 600 }}>
                        {num(r.sessoes)}
                      </span>
                    </div>
                    <div style={{ height: 4, borderRadius: 2, background: "var(--linha)" }}>
                      <div style={{
                        height: "100%", borderRadius: 2,
                        background: r.vendas > 0 ? "var(--positivo)" : "var(--acento)",
                        width: `${Math.max((r.sessoes / maxRegiao) * 100, 3)}%`,
                      }} />
                    </div>
                    {r.vendas > 0 && (
                      <div className="num" style={{
                        fontSize: 10, color: "var(--positivo)", marginTop: 3,
                      }}>
                        {num(r.vendas)} venda(s) · {dinheiro(r.faturamentoCents, true)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Cartao>

        <Nota>
          O faturamento e o lucro saem das suas vendas; o gasto vem da API de cada plataforma.
          {!temGasto && " Sem conta de anúncio conectada, ROAS e CPA não têm como ser calculados — e ficam em N/A, não em zero."}
          {ind.moedasIgnoradas.length > 0 && (
            <>
              {" "}Há conta de anúncio reportando em {ind.moedasIgnoradas.join(", ")}, e esse gasto
              ficou de fora do total: só somamos gasto na mesma moeda da loja. Converter aqui daria
              um número que depende da cotação do dia, e ninguém saberia qual foi usada. O Lucro, o
              ROAS e o CPA acima estão calculados sobre o gasto restante.
            </>
          )}
          {" "}Este painel mede por último clique da UTM; o Gerenciador da Meta mede por 7 dias de
          clique mais 1 de visualização. Os dois números vão divergir sempre, e isso não é defeito.
        </Nota>
      </div>
    </div>
  );
}
