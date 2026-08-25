"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { LojaDoUsuario } from "@/core/auth";

/*
 * Troca de dashboard, e criação de um novo.
 *
 * Um dashboard por oferta não é preciosismo de organização: é o que impede
 * duas ofertas de disparar conversão para o pixel uma da outra. O envio vai
 * para todos os destinos ativos da loja, então duas ofertas na mesma loja
 * fazem cada algoritmo otimizar com venda que não é dele.
 *
 * Havia um seletor aqui antes, removido quando era uma operação só. Voltou
 * porque passou a ser mais de uma.
 */

export function SeletorLoja({
  atual, lojas,
}: {
  atual: LojaDoUsuario | null;
  lojas: LojaDoUsuario[];
}) {
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [criando, setCriando] = useState(false);
  const [editando, setEditando] = useState<LojaDoUsuario | null>(null);
  const caixa = useRef<HTMLDivElement>(null);

  /* Clique fora e Esc fecham o menu, como todo menu. */
  useEffect(() => {
    if (!aberto) return;
    const fora = (e: MouseEvent) => {
      if (caixa.current && !caixa.current.contains(e.target as Node)) setAberto(false);
    };
    const tecla = (e: KeyboardEvent) => { if (e.key === "Escape") setAberto(false); };
    document.addEventListener("mousedown", fora);
    window.addEventListener("keydown", tecla);
    return () => {
      document.removeEventListener("mousedown", fora);
      window.removeEventListener("keydown", tecla);
    };
  }, [aberto]);

  async function trocar(slug: string) {
    if (slug === atual?.slug) { setAberto(false); return; }
    await fetch("/api/lojas", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    setAberto(false);
    /* refresh, não reload: o servidor relê o cookie e remonta as telas. */
    router.refresh();
  }

  return (
    <div ref={caixa} style={{ padding: "0 14px 14px", position: "relative" }}>
      <button
        onClick={() => setAberto((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={aberto}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 7,
          padding: "6px 8px", borderRadius: 5, textAlign: "left",
          border: "1px solid " + (aberto ? "var(--linha-forte)" : "transparent"),
          background: aberto ? "var(--painel-alto)" : "transparent",
          color: "var(--ink-fraco)", cursor: "pointer",
        }}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor"
             strokeWidth="1.5" style={{ flexShrink: 0 }}>
          <path d="M2.5 6h11l-1 7.5h-9L2.5 6zM5.5 6V4a2.5 2.5 0 0 1 5 0v2" />
        </svg>
        <span style={{
          flexGrow: 1, fontSize: 11.5, fontWeight: 500,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{atual?.nome ?? "sem dashboard"}</span>
        <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor"
             strokeWidth="1.8" style={{ flexShrink: 0, opacity: .7 }}>
          <path d={aberto ? "M2.5 7.5 6 4l3.5 3.5" : "M2.5 4.5 6 8l3.5-3.5"} />
        </svg>
      </button>

      {aberto && (
        <div role="listbox" style={{
          position: "absolute", left: 10, right: 10, top: "100%", zIndex: 30,
          background: "var(--painel-alto)", border: "1px solid var(--linha-forte)",
          borderRadius: 6, padding: 4, boxShadow: "0 10px 28px -12px rgba(0,0,0,.6)",
        }}>
          {lojas.map((l) => {
            const ativo = l.slug === atual?.slug;
            return (
              /*
                Duas ações na mesma linha, e por isso duas etiquetas irmãs em
                vez de uma dentro da outra: botão aninhado em botão é HTML
                inválido, e o navegador desmonta a árvore de um jeito que faz
                o clique cair no elemento errado.
              */
              <div key={l.slug} style={{
                display: "flex", alignItems: "center", gap: 2,
                borderRadius: 4, background: ativo ? "var(--linha)" : "transparent",
              }}>
                <button role="option" aria-selected={ativo}
                  onClick={() => trocar(l.slug)}
                  style={{
                    flexGrow: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6,
                    padding: "6px 8px", borderRadius: 4, textAlign: "left",
                    border: "none", background: "transparent",
                    color: ativo ? "var(--acento)" : "var(--ink-fraco)",
                    fontSize: 11.5, fontWeight: ativo ? 600 : 500, cursor: "pointer",
                  }}>
                  <span style={{ width: 10, flexShrink: 0 }}>{ativo ? "✓" : ""}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {l.nome}
                  </span>
                </button>
                <button
                  onClick={() => { setAberto(false); setEditando(l); }}
                  aria-label={`Configurar ${l.nome}`}
                  title="Renomear, ajustar ou excluir"
                  style={{
                    flexShrink: 0, width: 24, height: 24, display: "grid", placeItems: "center",
                    border: "none", background: "transparent", borderRadius: 4,
                    color: "var(--ink-tenue)", cursor: "pointer",
                  }}>
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
                       stroke="currentColor" strokeWidth="1.5">
                    <circle cx="8" cy="8" r="2" />
                    <path d="M8 1.5v1.7M8 12.8v1.7M14.5 8h-1.7M3.2 8H1.5M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2M12.6 12.6l-1.2-1.2M4.6 4.6L3.4 3.4" />
                  </svg>
                </button>
              </div>
            );
          })}

          <div style={{ height: 1, background: "var(--linha)", margin: "4px 0" }} />

          <button onClick={() => { setAberto(false); setCriando(true); }} style={{
            width: "100%", display: "flex", alignItems: "center", gap: 6,
            padding: "6px 8px", borderRadius: 4, textAlign: "left", border: "none",
            background: "transparent", color: "var(--acento)",
            fontSize: 11.5, fontWeight: 600, cursor: "pointer",
          }}>
            <span style={{ width: 10, flexShrink: 0 }}>+</span>
            <span>Novo dashboard</span>
          </button>
        </div>
      )}

      {criando && <DialogoNovoDashboard aoFechar={() => setCriando(false)} />}
      {editando && (
        <DialogoEditarDashboard
          loja={editando}
          ehUnico={lojas.length <= 1}
          aoFechar={() => setEditando(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------- editar -- */

function DialogoEditarDashboard({
  loja, ehUnico, aoFechar,
}: {
  loja: LojaDoUsuario;
  ehUnico: boolean;
  aoFechar: () => void;
}) {
  const router = useRouter();
  const [nome, setNome] = useState(loja.nome);
  const [descricao, setDescricao] = useState(loja.descricao ?? "");
  const [timezone, setTimezone] = useState(loja.timezone);
  const [moeda, setMoeda] = useState(loja.currency);
  const [contarFrete, setContarFrete] = useState(loja.countShipping);
  const [contarJuros, setContarJuros] = useState(loja.countInterest);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  /* A exclusão fica atrás de um segundo passo, e não de um botão solto. */
  const [excluindo, setExcluindo] = useState(false);
  const [confirmacao, setConfirmacao] = useState("");

  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === "Escape" && !salvando) aoFechar(); };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [aoFechar, salvando]);

  async function salvar() {
    setSalvando(true);
    setErro(null);
    const r = await fetch("/api/lojas", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: loja.slug, nome, descricao, timezone, moeda, contarFrete, contarJuros,
      }),
    }).catch(() => null);

    if (!r || !r.ok) {
      setErro((await r?.json().catch(() => null))?.erro ?? "não deu para salvar");
      setSalvando(false);
      return;
    }
    aoFechar();
    router.refresh();
  }

  async function excluir() {
    setSalvando(true);
    setErro(null);
    const r = await fetch("/api/lojas", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: loja.slug, confirmacao }),
    }).catch(() => null);

    if (!r || !r.ok) {
      setErro((await r?.json().catch(() => null))?.erro ?? "não deu para excluir");
      setSalvando(false);
      return;
    }
    aoFechar();
    router.refresh();
  }

  return (
    <div onClick={aoFechar} style={{
      position: "fixed", inset: 0, zIndex: 60, display: "flex",
      alignItems: "center", justifyContent: "center", padding: 20,
      background: "rgba(4, 10, 14, .66)",
    }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Configurar dashboard"
        style={{
          width: "min(460px, 100%)", background: "var(--painel)",
          border: "1px solid var(--linha-forte)", borderRadius: 10, overflow: "hidden",
        }}>

        <div style={{ padding: "16px 20px 12px", borderBottom: "1px solid var(--linha)" }}>
          <div style={{ fontSize: 14.5, fontWeight: 700, marginBottom: 3 }}>
            {excluindo ? "Excluir dashboard" : "Configurar dashboard"}
          </div>
          <div style={{ fontSize: 12, color: "var(--ink-tenue)", lineHeight: 1.5 }}>
            {excluindo
              ? "Some tudo: vendas, sessões de clique, eventos, disparos e conexões. Não há como desfazer."
              : loja.slug}
          </div>
        </div>

        {excluindo ? (
          <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{
              fontSize: 12.5, color: "var(--ink-medio)", lineHeight: 1.55,
              padding: "11px 13px", borderRadius: 6,
              background: "var(--negativo-fundo)", border: "1px solid var(--negativo)",
            }}>
              Para confirmar, digite <strong style={{ color: "var(--ink)" }}>{loja.nome}</strong> abaixo.
            </div>
            <input value={confirmacao} autoFocus onChange={(e) => setConfirmacao(e.target.value)}
              placeholder={loja.nome} style={{ width: "100%" }} />
            {erro && <Erro texto={erro} />}
          </div>
        ) : (
          <div style={{
            padding: "16px 20px", display: "flex", flexDirection: "column", gap: 13,
            maxHeight: "58vh", overflowY: "auto",
          }}>
            <Campo rotulo="Nome">
              <input value={nome} autoFocus onChange={(e) => setNome(e.target.value)} style={{ width: "100%" }} />
            </Campo>
            <Campo rotulo="Descrição" opcional>
              <input value={descricao} onChange={(e) => setDescricao(e.target.value)} style={{ width: "100%" }} />
            </Campo>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Campo rotulo="Fuso horário">
                <select value={timezone} onChange={(e) => setTimezone(e.target.value)} style={{ width: "100%" }}>
                  <option value="America/Sao_Paulo">GMT-3 · Brasília</option>
                  <option value="America/Manaus">GMT-4 · Manaus</option>
                  <option value="America/Rio_Branco">GMT-5 · Rio Branco</option>
                  <option value="America/Noronha">GMT-2 · Noronha</option>
                  <option value="UTC">UTC</option>
                </select>
              </Campo>
              <Campo rotulo="Moeda">
                <select value={moeda} onChange={(e) => setMoeda(e.target.value)} style={{ width: "100%" }}>
                  <option value="BRL">Real (R$)</option>
                  <option value="USD">Dólar (US$)</option>
                  <option value="EUR">Euro (€)</option>
                </select>
              </Campo>
            </div>
            <Campo rotulo="Contabilizar frete"
              ajuda="Mudar isto recalcula ROAS, lucro e margem de todo o histórico deste dashboard.">
              <select value={contarFrete ? "1" : "0"} onChange={(e) => setContarFrete(e.target.value === "1")} style={{ width: "100%" }}>
                <option value="1">Habilitado — entra no faturamento</option>
                <option value="0">Não habilitado — fica de fora</option>
              </select>
            </Campo>
            <Campo rotulo="Contabilizar juros">
              <select value={contarJuros ? "1" : "0"} onChange={(e) => setContarJuros(e.target.value === "1")} style={{ width: "100%" }}>
                <option value="1">Habilitado — entra no faturamento</option>
                <option value="0">Não habilitado — fica de fora</option>
              </select>
            </Campo>
            {erro && <Erro texto={erro} />}
          </div>
        )}

        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8,
          padding: "12px 20px", borderTop: "1px solid var(--linha)",
        }}>
          {excluindo ? (
            <>
              <button onClick={() => { setExcluindo(false); setErro(null); }} style={botaoNeutro}>Voltar</button>
              <button onClick={excluir} disabled={salvando || confirmacao !== loja.nome} style={{
                ...botaoPrimario, background: "var(--negativo)", color: "#2B1614",
                opacity: salvando || confirmacao !== loja.nome ? .5 : 1,
              }}>{salvando ? "excluindo…" : "Excluir para sempre"}</button>
            </>
          ) : (
            <>
              {/*
                Sem outro dashboard, excluir deixaria o painel sem nenhum e sem
                caminho de volta pela interface. O botão some em vez de falhar
                depois do clique.
              */}
              {ehUnico ? <span style={{ fontSize: 11, color: "var(--ink-tenue)" }}>
                único dashboard
              </span> : (
                <button onClick={() => setExcluindo(true)} style={{
                  ...botaoNeutro, borderColor: "transparent", color: "var(--negativo)",
                }}>Excluir</button>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={aoFechar} disabled={salvando} style={botaoNeutro}>Cancelar</button>
                <button onClick={salvar} disabled={salvando || nome.trim().length < 2} style={{
                  ...botaoPrimario, opacity: salvando || nome.trim().length < 2 ? .5 : 1,
                }}>{salvando ? "salvando…" : "Salvar"}</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Erro({ texto }: { texto: string }) {
  return (
    <div style={{
      fontSize: 12, color: "var(--negativo)", padding: "9px 11px", borderRadius: 5,
      background: "var(--negativo-fundo)", border: "1px solid var(--negativo)",
    }}>{texto}</div>
  );
}

const botaoNeutro: React.CSSProperties = {
  padding: "7px 14px", borderRadius: 5, fontSize: 12, fontWeight: 500,
  border: "1px solid var(--linha-forte)", background: "transparent",
  color: "var(--ink-medio)",
};

/* ------------------------------------------------------------ criação -- */

function DialogoNovoDashboard({ aoFechar }: { aoFechar: () => void }) {
  const router = useRouter();
  const [nome, setNome] = useState("");
  const [descricao, setDescricao] = useState("");
  const [dominio, setDominio] = useState("");
  const [timezone, setTimezone] = useState("America/Sao_Paulo");
  const [moeda, setMoeda] = useState("BRL");
  const [contarFrete, setContarFrete] = useState(true);
  const [contarJuros, setContarJuros] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [pronto, setPronto] = useState<{ slug: string; siteKey: string | null } | null>(null);

  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === "Escape" && !salvando) aoFechar(); };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [aoFechar, salvando]);

  async function criar() {
    setSalvando(true);
    setErro(null);
    try {
      const r = await fetch("/api/lojas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nome, descricao, timezone, moeda, contarFrete, contarJuros,
          dominio: dominio.trim() || undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok) { setErro(j.erro ?? "não deu para criar"); setSalvando(false); return; }
      setPronto({ slug: j.slug, siteKey: j.siteKey ?? null });
    } catch {
      setErro("sem conexão com o servidor");
    }
    setSalvando(false);
  }

  function concluir() {
    aoFechar();
    router.refresh();
  }

  return (
    <div onClick={pronto ? concluir : aoFechar} style={{
      position: "fixed", inset: 0, zIndex: 60, display: "flex",
      alignItems: "center", justifyContent: "center", padding: 20,
      background: "rgba(4, 10, 14, .66)",
    }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Novo dashboard"
        style={{
          width: "min(460px, 100%)", background: "var(--painel)",
          border: "1px solid var(--linha-forte)", borderRadius: 10, overflow: "hidden",
        }}>

        <div style={{ padding: "16px 20px 12px", borderBottom: "1px solid var(--linha)" }}>
          <div style={{ fontSize: 14.5, fontWeight: 700, marginBottom: 3 }}>
            {pronto ? "Dashboard criado" : "Novo dashboard"}
          </div>
          <div style={{ fontSize: 12, color: "var(--ink-tenue)", lineHeight: 1.5 }}>
            {pronto
              ? "Você já está dentro dele. Conecte gateway e pixel em Integrações."
              : "Um por oferta. Gateways, pixels e contas de anúncio ficam isolados — é o que impede uma oferta de disparar conversão para o pixel da outra."}
          </div>
        </div>

        {pronto ? (
          <div style={{ padding: "16px 20px" }}>
            {pronto.siteKey ? (
              <>
                <div style={{
                  fontSize: 10, letterSpacing: ".07em", textTransform: "uppercase",
                  color: "var(--ink-tenue)", fontWeight: 600, marginBottom: 6,
                }}>Chave do site</div>
                <div className="num" style={{
                  fontSize: 12, padding: "9px 11px", borderRadius: 5, wordBreak: "break-all",
                  background: "var(--painel-alto)", border: "1px solid var(--linha)",
                  color: "var(--acento)", marginBottom: 10,
                }}>{pronto.siteKey}</div>
                <div style={{ fontSize: 12, color: "var(--ink-tenue)", lineHeight: 1.5 }}>
                  É ela que vai no <code>siteKey</code> do snippet, nesta oferta. Cada
                  dashboard tem a sua — trocar a chave é o que separa o que entra em cada um.
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12.5, color: "var(--ink-fraco)", lineHeight: 1.55 }}>
                Sem domínio, o dashboard existe mas não coleta nada ainda. Cadastre o site
                em Integrações para receber a chave do snippet.
              </div>
            )}
          </div>
        ) : (
          <div style={{
            padding: "16px 20px", display: "flex", flexDirection: "column", gap: 13,
            maxHeight: "62vh", overflowY: "auto",
          }}>
            <Campo rotulo="Nome">
              <input value={nome} autoFocus onChange={(e) => setNome(e.target.value)}
                placeholder="Oferta Carimbo Gatinho" style={{ width: "100%" }}
                onKeyDown={(e) => { if (e.key === "Enter" && nome.trim().length >= 2) criar(); }} />
            </Campo>

            <Campo rotulo="Descrição" opcional>
              <input value={descricao} onChange={(e) => setDescricao(e.target.value)}
                placeholder="somente vendas do carimbo" style={{ width: "100%" }} />
            </Campo>

            <Campo rotulo="Domínio" opcional
              ajuda="Preenchendo agora, a chave do snippet já sai pronta.">
              <input value={dominio} onChange={(e) => setDominio(e.target.value)}
                placeholder="minhaoferta.com.br" style={{ width: "100%" }} />
            </Campo>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Campo rotulo="Fuso horário">
                <select value={timezone} onChange={(e) => setTimezone(e.target.value)} style={{ width: "100%" }}>
                  <option value="America/Sao_Paulo">GMT-3 · Brasília</option>
                  <option value="America/Manaus">GMT-4 · Manaus</option>
                  <option value="America/Rio_Branco">GMT-5 · Rio Branco</option>
                  <option value="America/Noronha">GMT-2 · Noronha</option>
                  <option value="UTC">UTC</option>
                </select>
              </Campo>
              <Campo rotulo="Moeda">
                <select value={moeda} onChange={(e) => setMoeda(e.target.value)} style={{ width: "100%" }}>
                  <option value="BRL">Real (R$)</option>
                  <option value="USD">Dólar (US$)</option>
                  <option value="EUR">Euro (€)</option>
                </select>
              </Campo>
            </div>

            {/*
              Estes dois não são preferência de exibição: mudam o ROAS. O gateway
              cobra produto + frete + juro e manda o total. Quem repassa o frete
              ao transportador não faturou aquilo.
            */}
            <Campo rotulo="Contabilizar frete"
              ajuda="Desligue se o frete vai inteiro para o transportador — contar infla o faturamento com dinheiro que sai no mesmo dia.">
              <select value={contarFrete ? "1" : "0"} onChange={(e) => setContarFrete(e.target.value === "1")} style={{ width: "100%" }}>
                <option value="1">Habilitado — entra no faturamento</option>
                <option value="0">Não habilitado — fica de fora</option>
              </select>
            </Campo>

            <Campo rotulo="Contabilizar juros"
              ajuda="Juro do parcelamento cobrado do comprador. Costuma ficar com o gateway, não com você.">
              <select value={contarJuros ? "1" : "0"} onChange={(e) => setContarJuros(e.target.value === "1")} style={{ width: "100%" }}>
                <option value="1">Habilitado — entra no faturamento</option>
                <option value="0">Não habilitado — fica de fora</option>
              </select>
            </Campo>
            {erro && (
              <div style={{
                fontSize: 12, color: "var(--negativo)", padding: "9px 11px", borderRadius: 5,
                background: "var(--negativo-fundo)", border: "1px solid var(--negativo)",
              }}>{erro}</div>
            )}
          </div>
        )}

        <div style={{
          display: "flex", justifyContent: "flex-end", gap: 8,
          padding: "12px 20px", borderTop: "1px solid var(--linha)",
        }}>
          {pronto ? (
            <button onClick={concluir} style={botaoPrimario}>Ir para o dashboard</button>
          ) : (
            <>
              <button onClick={aoFechar} disabled={salvando} style={{
                padding: "7px 14px", borderRadius: 5, fontSize: 12, fontWeight: 500,
                border: "1px solid var(--linha-forte)", background: "transparent",
                color: "var(--ink-medio)",
              }}>Cancelar</button>
              <button onClick={criar} disabled={salvando || nome.trim().length < 2}
                style={{
                  ...botaoPrimario,
                  opacity: salvando || nome.trim().length < 2 ? .5 : 1,
                }}>{salvando ? "criando…" : "Criar"}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Campo({ rotulo, opcional, ajuda, children }: {
  rotulo: string; opcional?: boolean; ajuda?: string; children: React.ReactNode;
}) {
  return (
    <div>
      <div style={{
        fontSize: 10, letterSpacing: ".07em", textTransform: "uppercase",
        color: "var(--ink-tenue)", fontWeight: 600, marginBottom: 5,
      }}>
        {rotulo}
        {opcional && <span style={{ textTransform: "none", letterSpacing: 0 }}> (opcional)</span>}
      </div>
      {children}
      {ajuda && (
        <div style={{ fontSize: 11.5, color: "var(--ink-tenue)", marginTop: 5, lineHeight: 1.45 }}>
          {ajuda}
        </div>
      )}
    </div>
  );
}

const botaoPrimario: React.CSSProperties = {
  padding: "7px 16px", borderRadius: 5, border: "none",
  background: "var(--acento)", color: "#062026", fontSize: 12, fontWeight: 600,
};
