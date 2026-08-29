"use client";

import { useDinheiro } from "./moeda";

import { Cabecalho, Cartao, Nota } from "./comum";
import type { Verificacao, Estado, EventoRecebido, EntregaRecebida } from "@/core/diagnostico";

/*
 * A tela de Testes.
 *
 * Quatro perguntas na ordem em que o dado atravessa o sistema. A ordem é o
 * conteúdo: se o script não dispara, não adianta investigar o pixel — o pixel
 * está certo e sem nada para enviar. A primeira etapa vermelha é a única que
 * importa, e as seguintes são consequência dela.
 *
 * Por isso as etapas depois da primeira falha aparecem apagadas, em vez de
 * também em vermelho. Quatro alarmes ao mesmo tempo escondem qual é o problema.
 */

const CORES: Record<Estado, { cor: string; fundo: string; rotulo: string }> = {
  ok: { cor: "var(--positivo)", fundo: "var(--positivo-fundo)", rotulo: "funcionando" },
  atencao: { cor: "var(--alerta)", fundo: "var(--alerta-fundo)", rotulo: "atenção" },
  parado: { cor: "var(--negativo)", fundo: "var(--negativo-fundo)", rotulo: "parado" },
  nunca: { cor: "var(--ink-tenue)", fundo: "var(--linha)", rotulo: "não configurado" },
};

function Marca({ estado }: { estado: Estado }) {
  const c = CORES[estado];
  if (estado === "ok") {
    return (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke={c.cor} strokeWidth="2">
        <circle cx="10" cy="10" r="8" opacity=".35" />
        <path d="M6 10.5l2.6 2.6L14 7.5" />
      </svg>
    );
  }
  if (estado === "atencao") {
    return (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke={c.cor} strokeWidth="1.8">
        <path d="M10 2.5l8 15H2l8-15z" /><path d="M10 8v4M10 14.5h.01" />
      </svg>
    );
  }
  if (estado === "parado") {
    return (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke={c.cor} strokeWidth="2">
        <circle cx="10" cy="10" r="8" opacity=".35" />
        <path d="M7 7l6 6M13 7l-6 6" />
      </svg>
    );
  }
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke={c.cor} strokeWidth="1.8">
      <circle cx="10" cy="10" r="8" strokeDasharray="3 3" />
    </svg>
  );
}

export function Testes({
  periodo, verificacoes, eventos, entregas, temSite,
}: {
  periodo: string;
  verificacoes: Verificacao[];
  eventos: EventoRecebido[];
  entregas: EntregaRecebida[];
  temSite: boolean;
}) {
  const dinheiro = useDinheiro();
  /*
   * Índice da primeira etapa que não está ok. Tudo depois dela vira
   * consequência, e é mostrado apagado.
   */
  const primeiraFalha = verificacoes.findIndex((v) => v.estado !== "ok");
  const tudoOk = primeiraFalha === -1;

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <Cabecalho
        titulo="Testes"
        descricao="Se a instalação está funcionando, e onde exatamente ela para quando não está."
        periodo={periodo}
      />

      <div style={{ padding: "16px 20px 28px", display: "flex", flexDirection: "column", gap: 14 }}>

        {tudoOk && (
          <div style={{
            padding: "13px 17px", borderRadius: 8, maxWidth: 900,
            background: "var(--positivo-fundo)", border: "1px solid #1C3A31",
            fontSize: 12.5, color: "var(--ink-medio)",
          }}>
            <strong style={{ color: "var(--positivo)" }}>Caminho completo funcionando.</strong>{" "}
            O site dispara, o gateway notifica, e as conversões estão saindo.
          </div>
        )}

        {/* as quatro etapas */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 900 }}>
          {verificacoes.map((v, i) => {
            const c = CORES[v.estado];
            const consequencia = !tudoOk && i > primeiraFalha;
            return (
              <div key={v.etapa} style={{
                display: "flex", gap: 13, padding: "14px 17px", borderRadius: 8,
                background: "var(--painel)",
                border: `1px solid ${consequencia ? "var(--linha)" : v.estado === "ok" ? "var(--linha)" : c.cor}`,
                opacity: consequencia ? 0.45 : 1,
              }}>
                <div style={{ flexShrink: 0, marginTop: 1 }}><Marca estado={v.estado} /></div>

                <div style={{ flexGrow: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 3 }}>
                    <span className="num" style={{
                      fontSize: 10.5, letterSpacing: ".06em", textTransform: "uppercase",
                      color: "var(--ink-tenue)", fontWeight: 600,
                    }}>{v.etapa}</span>
                    <span style={{
                      fontSize: 10, padding: "1px 7px", borderRadius: 9,
                      background: c.fundo, color: c.cor, fontWeight: 600,
                    }}>{c.rotulo}</span>
                  </div>

                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>{v.pergunta}</div>
                  <div className="num" style={{ fontSize: 11.5, color: "var(--ink-fraco)" }}>{v.detalhe}</div>

                  {v.conserto && !consequencia && (
                    <div style={{
                      marginTop: 9, padding: "9px 11px", borderRadius: 5,
                      background: "var(--painel-alto)", fontSize: 11.5,
                      color: "var(--ink-medio)", lineHeight: 1.5,
                    }}>{v.conserto}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {!temSite && (
          <div style={{
            padding: "13px 17px", borderRadius: 8, maxWidth: 900,
            background: "var(--alerta-fundo)", border: "1px solid var(--alerta)",
            fontSize: 12.5, color: "var(--ink-medio)",
          }}>
            Esta loja não tem site cadastrado, então nem existe chave para o script usar.
            Cadastre em <strong>Integrações</strong> antes de tentar instalar.
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 12, alignItems: "start" }}>

          {/* eventos ao vivo */}
          <Cartao
            titulo="Eventos que chegaram"
            descricao="Atualiza sozinho. Abra seu site em outra aba e veja aparecer aqui."
          >
            {eventos.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--ink-tenue)", lineHeight: 1.55 }}>
                Nada ainda. Depois de colar o script, abra qualquer página do site —
                o <span className="num">page_view</span> deve aparecer aqui em segundos.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {eventos.map((e, i) => (
                  <div key={i} style={{
                    display: "grid", gridTemplateColumns: "0.85fr 1fr 0.9fr 1.3fr 0.6fr",
                    gap: 10, padding: "7px 0", alignItems: "center",
                    borderBottom: i === eventos.length - 1 ? "none" : "1px solid var(--linha)",
                    fontSize: 11.5,
                  }}>
                    <span className="num" style={{ color: "var(--ink-tenue)" }}>{e.quando}</span>
                    <span className="num" style={{ color: "var(--acento)", fontWeight: 500 }}>{e.nome}</span>
                    <span className="num" style={{
                      color: "var(--ink-fraco)", overflow: "hidden",
                      textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>{e.origem}</span>
                    <span style={{
                      color: "var(--ink-tenue)", overflow: "hidden",
                      textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }} title={e.campanha ?? e.pagina ?? undefined}>
                      {e.campanha ?? (e.pagina ? new URL(e.pagina).pathname : "—")}
                    </span>
                    <span className="num" style={{ textAlign: "right", color: "var(--ink-fraco)" }}>
                      {e.valorCents === null ? "" : dinheiro(e.valorCents)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Cartao>

          {/* webhooks */}
          <Cartao
            titulo="Notificações de venda"
            descricao="O que os gateways mandaram, verificado ou não."
          >
            {entregas.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--ink-tenue)", lineHeight: 1.55 }}>
                Nenhuma ainda. Aponte a URL de webhook no painel do gateway e faça
                uma venda de teste.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {entregas.map((e, i) => (
                  <div key={i} style={{
                    padding: "8px 0",
                    borderBottom: i === entregas.length - 1 ? "none" : "1px solid var(--linha)",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                      <span className="num" style={{ fontSize: 11, color: "var(--ink-tenue)" }}>{e.quando}</span>
                      <span style={{ fontSize: 11.5, fontWeight: 500, flexGrow: 1 }}>{e.gateway}</span>
                      <span className="num" style={{
                        fontSize: 9.5, padding: "1px 6px", borderRadius: 8,
                        background: e.verificada ? "var(--positivo-fundo)" : "var(--linha)",
                        color: e.verificada ? "var(--positivo)" : "var(--ink-tenue)",
                      }}>{e.verificada ? "verificada" : "não verificada"}</span>
                    </div>
                    {e.erro ? (
                      <div style={{ fontSize: 10.5, color: "var(--negativo)" }}>{e.erro}</div>
                    ) : (
                      <div style={{ fontSize: 10.5, color: "var(--ink-tenue)" }}>
                        {e.processada ? "processada" : "recebida, ainda não processada"}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Cartao>
        </div>

        <Nota>
          &ldquo;Não verificada&rdquo; não quer dizer suspeita: quer dizer que o gateway não
          assina o webhook e não há credencial de API cadastrada para confirmar a venda na
          origem. Cadastre a chave em <strong style={{ color: "var(--ink-fraco)" }}>Integrações → Webhooks</strong> e
          as próximas passam a ser conferidas.
        </Nota>
      </div>
    </div>
  );
}
