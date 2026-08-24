"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { LojaDoUsuario } from "@/core/auth";

/*
 * Tela de Integrações.
 *
 * Quatro abas, na ordem em que uma loja nova precisa delas: primeiro de onde
 * vem o gasto (Anúncios), depois de onde vem a venda (Webhooks), depois como o
 * anúncio marca o clique (UTMs) e por fim para onde a conversão é enviada
 * (Pixel).
 *
 * Nenhum segredo já gravado volta para cá. A tela mostra que existe token,
 * nunca o token — um campo preenchido com a credencial seria uma cópia dela em
 * texto puro no navegador, a cada carregamento da página.
 */

type Aba = "anuncios" | "webhooks" | "utms" | "pixel";

interface Conta {
  id: string; plataforma: string; externalId: string; label: string;
  ativo: boolean; temCredencial: boolean; sincronizadoEm: string | null;
}
interface Conexao {
  id: string; gateway: string; label: string; ativo: boolean;
  segredo: string; temCredencial: boolean;
}
interface Pixel {
  id: string; plataforma: string; externalId: string; label: string;
  ativo: boolean; codigoTeste: string | null;
  eventos: string[] | null; textoBotao: string | null;
}

const PLATAFORMAS = [
  { id: "meta", nome: "Meta Ads", cor: "#4A7BC8" },
  { id: "google", nome: "Google Ads", cor: "#D6A344" },
  { id: "kwai", nome: "Kwai Ads", cor: "#E8763C" },
  { id: "tiktok", nome: "TikTok Ads", cor: "#45C4D0" },
  { id: "taboola", nome: "Taboola", cor: "#4A7BC8" },
];

/*
 * Cada plataforma pede credencial diferente, e a diferença não é cosmética.
 *
 * Meta e TikTok aceitam um token longo e pronto. O Google exige OAuth2 —
 * refresh token trocado por acesso a cada hora — mais um developer token que
 * ELE precisa aprovar, o que leva dias. Mostrar os mesmos dois campos para os
 * três faria o cadastro do Google parecer completo e não funcionar.
 */
const CREDENCIAIS: Record<string, Array<{
  chave: string; rotulo: string; dica?: string; segredo?: boolean; opcional?: boolean;
}>> = {
  meta: [
    { chave: "accessToken", rotulo: "Token de usuário de sistema", segredo: true,
      dica: "Business Manager → Usuários do sistema → Gerar token, com escopo ads_read e expiração Nunca." },
  ],
  tiktok: [
    { chave: "accessToken", rotulo: "Access token", segredo: true,
      dica: "TikTok Ads Manager → Ferramentas → Events API, ou no portal de desenvolvedor." },
  ],
  kwai: [
    { chave: "accessToken", rotulo: "Access token", segredo: true },
  ],
  taboola: [
    { chave: "accessToken", rotulo: "Access token", segredo: true },
  ],
  google: [
    { chave: "developerToken", rotulo: "Developer token", segredo: true,
      dica: "Do API Center do Google Ads. Precisa de aprovação deles — sai em dias, não na hora." },
    { chave: "clientId", rotulo: "Client ID",
      dica: "Do projeto OAuth no Google Cloud Console." },
    { chave: "clientSecret", rotulo: "Client secret", segredo: true },
    { chave: "refreshToken", rotulo: "Refresh token", segredo: true,
      dica: "Do consentimento único que o dono da conta dá." },
    { chave: "loginCustomerId", rotulo: "ID da gerenciadora (MCC)", opcional: true,
      dica: "Só quando a conta é acessada por uma gerenciadora. Em branco se não for." },
  ],
};

const EVENTOS = [
  { id: "view_content", rotulo: "Ver produto", padrao: true },
  { id: "add_to_cart", rotulo: "Adicionar ao carrinho", padrao: true },
  { id: "initiate_checkout", rotulo: "Iniciar checkout", padrao: true },
  { id: "purchase", rotulo: "Compra", padrao: true },
  { id: "lead", rotulo: "Lead", padrao: true },
  { id: "page_view", rotulo: "Página vista", padrao: false },
];

/* ------------------------------------------------------------- peças -- */

function Cartao({ titulo, descricao, children }: {
  titulo: string; descricao?: string; children: React.ReactNode;
}) {
  return (
    <div style={{
      background: "var(--painel)", border: "1px solid var(--linha)",
      borderRadius: 8, overflow: "hidden",
    }}>
      <div style={{ padding: "14px 18px 13px", borderBottom: "1px solid var(--linha)" }}>
        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{titulo}</div>
        {descricao && (
          <div style={{ fontSize: 11.5, color: "var(--ink-tenue)", marginTop: 3 }}>{descricao}</div>
        )}
      </div>
      <div style={{ padding: 18 }}>{children}</div>
    </div>
  );
}

function Botao({ children, onClick, tipo = "primario", pequeno, ...resto }: {
  children: React.ReactNode; onClick?: () => void;
  tipo?: "primario" | "secundario"; pequeno?: boolean;
  disabled?: boolean; type?: "button" | "submit";
}) {
  const primario = tipo === "primario";
  return (
    <button onClick={onClick} {...resto} style={{
      padding: pequeno ? "5px 11px" : "9px 16px",
      borderRadius: 5, fontWeight: 600, fontSize: pequeno ? 11.5 : 12.5,
      border: primario ? "none" : "1px solid var(--linha-forte)",
      background: primario ? "var(--acento)" : "transparent",
      color: primario ? "#062026" : "var(--ink-fraco)",
    }}>{children}</button>
  );
}

function Campo({ rotulo, dica, ...resto }: {
  rotulo: string; dica?: string;
  value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string; type?: string;
}) {
  return (
    <label style={{ display: "block", marginBottom: 13 }}>
      <span style={{
        display: "block", fontSize: 10.5, letterSpacing: ".07em",
        textTransform: "uppercase", color: "var(--ink-tenue)",
        fontWeight: 600, marginBottom: 5,
      }}>{rotulo}</span>
      <input {...resto} />
      {dica && (
        <span style={{ display: "block", fontSize: 11, color: "var(--ink-tenue)", marginTop: 4 }}>
          {dica}
        </span>
      )}
    </label>
  );
}

function Selo({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span className="num" style={{
      fontSize: 10, padding: "2px 7px", borderRadius: 10, whiteSpace: "nowrap",
      background: ok ? "var(--positivo-fundo)" : "var(--linha)",
      color: ok ? "var(--positivo)" : "var(--ink-tenue)",
    }}>{children}</span>
  );
}

function Copiavel({ valor, rotulo }: { valor: string; rotulo?: string }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <div>
      {rotulo && (
        <div style={{
          fontSize: 10.5, letterSpacing: ".07em", textTransform: "uppercase",
          color: "var(--ink-tenue)", fontWeight: 600, marginBottom: 5,
        }}>{rotulo}</div>
      )}
      <div style={{ display: "flex", gap: 7, alignItems: "stretch" }}>
        <code className="num" style={{
          flexGrow: 1, minWidth: 0, background: "#0A1014",
          border: "1px solid var(--linha-forte)", borderRadius: 5,
          padding: "9px 11px", fontSize: 11.5, color: "var(--ink-medio)",
          overflowX: "auto", whiteSpace: "nowrap",
        }}>{valor}</code>
        <button
          onClick={() => {
            navigator.clipboard.writeText(valor);
            setCopiado(true);
            setTimeout(() => setCopiado(false), 1600);
          }}
          style={{
            flexShrink: 0, padding: "0 12px", borderRadius: 5,
            border: "1px solid var(--linha-forte)", background: "var(--painel-alto)",
            color: copiado ? "var(--positivo)" : "var(--ink-fraco)", fontSize: 11.5, fontWeight: 600,
          }}
        >{copiado ? "copiado" : "copiar"}</button>
      </div>
    </div>
  );
}

/* ============================================================= tela == */

/*
 * O formato da venda empurrada por API.
 *
 * Fica na tela porque o campo mais fácil de errar é o de dinheiro, e errar não
 * dá erro: `valor` é na moeda e `valor_centavos` é em centavos, sempre. 19990
 * no campo errado vira R$ 19.990,00 em vez de R$ 199,90 — cem vezes mais, e é
 * esse número que a Meta usa para otimizar.
 */
const CORPO_EXEMPLO = `{
  "pedido_id": "12345",
  "status": "pago",
  "valor": 197.00,
  "metodo": "pix",
  "click_id": "<o que o rr.js pôs no checkout>",
  "cliente": {
    "nome": "Maria Souza",
    "email": "maria@exemplo.com",
    "telefone": "(11) 98888-7777",
    "documento": "000.000.000-00",
    "cep": "01310-100",
    "cidade": "São Paulo",
    "estado": "SP",
    "nascimento": "1990-05-12",
    "genero": "f"
  },
  "itens": [
    { "sku": "KIT-3", "nome": "Kit 3 unidades", "quantidade": 1, "preco": 197.00 }
  ]
}`;

function ExemploApi() {
  const [aberto, setAberto] = useState(false);

  return (
    <div style={{ marginTop: 10 }}>
      <button
        onClick={() => setAberto((a) => !a)}
        style={{
          background: "none", border: "none", padding: 0, cursor: "pointer",
          color: "var(--acento)", fontSize: 11, fontWeight: 600,
        }}
      >
        {aberto ? "esconder o formato" : "ver o formato do envio"}
      </button>

      {aberto && (
        <>
          <pre style={{
            marginTop: 9, marginBottom: 0, padding: 12, borderRadius: 6,
            background: "var(--fundo)", border: "1px solid var(--linha)",
            fontSize: 10.5, lineHeight: 1.5, overflowX: "auto",
            color: "var(--ink-medio)",
          }}>{CORPO_EXEMPLO}</pre>

          <div style={{ fontSize: 10.5, color: "var(--ink-tenue)", marginTop: 8, lineHeight: 1.6 }}>
            <strong style={{ color: "var(--ink-medio)" }}>valor</strong> é na moeda
            (197.00 = R$ 197,00). Se preferir mandar em centavos, use{" "}
            <strong style={{ color: "var(--ink-medio)" }}>valor_centavos</strong> (19700).
            Nunca os dois.<br />
            Os nomes também funcionam em inglês (<span className="num">order_id</span>,{" "}
            <span className="num">amount</span>, <span className="num">customer</span>).<br />
            Mandar o mesmo pedido duas vezes não duplica a venda; mudança de
            estado passa.<br />
            O endereço tem o segredo no caminho — mantenha no servidor, nunca em
            código de navegador.
          </div>
        </>
      )}
    </div>
  );
}

export function Integracoes({
  loja, base, site, contas, conexoes, pixels, gatewaysDisponiveis, modelosUtm,
}: {
  loja: LojaDoUsuario;
  base: string;
  site: { dominio: string; chave: string } | null;
  contas: Conta[];
  conexoes: Conexao[];
  pixels: Pixel[];
  gatewaysDisponiveis: Array<{ id: string; label: string; repasse: string }>;
  modelosUtm: Record<string, { rotulo: string; modelo: string; nota: string }>;
}) {
  const router = useRouter();
  const [aba, setAba] = useState<Aba>("anuncios");
  const [editando, setEditando] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [eventosSel, setEventosSel] = useState<string[]>(
    EVENTOS.filter((e) => e.padrao).map((e) => e.id),
  );

  const campo = (k: string) => ({
    value: form[k] ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value })),
  });

  async function salvar(corpo: Record<string, unknown>) {
    setSalvando(true);
    setErro(null);
    try {
      const r = await fetch("/api/integracoes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: loja.id, ...corpo }),
      });
      const j = await r.json();
      if (!r.ok) { setErro(j.erro ?? "falha ao gravar"); setSalvando(false); return; }
      setEditando(null);
      setForm({});
      router.refresh();
    } catch {
      setErro("sem conexão com o servidor");
    }
    setSalvando(false);
  }

  async function desativar(tipo: string, id: string) {
    await fetch(`/api/integracoes?tenantId=${loja.id}&tipo=${tipo}&id=${id}`, { method: "DELETE" });
    router.refresh();
  }

  const ABAS: Array<{ id: Aba; rotulo: string; icone: string }> = [
    { id: "anuncios", rotulo: "Anúncios", icone: "M6 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM14 6.5l-6 2M14 13.5l-6-3M14 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM14 16a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" },
    { id: "webhooks", rotulo: "Webhooks", icone: "M10 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6.5 6.5a5 5 0 0 0 0 7M13.5 6.5a5 5 0 0 1 0 7" },
    { id: "utms", rotulo: "UTMs", icone: "M4 6h12M4 10h12M4 14h7" },
    { id: "pixel", rotulo: "Pixel", icone: "M7 6l-3 4 3 4M13 6l3 4-3 4" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>

      <div style={{
        padding: "18px 24px 0", borderBottom: "1px solid var(--linha)",
        background: "var(--painel)",
      }}>
        <div style={{ marginBottom: 16 }}>
          <h1 style={{ fontSize: 17, fontWeight: 700, margin: 0, letterSpacing: "-.2px" }}>Integrações</h1>
          <p style={{ fontSize: 12, color: "var(--ink-tenue)", margin: "3px 0 0" }}>
            Tudo que o RRTrack precisa saber para medir <strong style={{ color: "var(--ink-medio)" }}>{loja.nome}</strong>.
          </p>
        </div>

        <div style={{ display: "flex", gap: 26 }}>
          {ABAS.map((a) => (
            <button key={a.id} onClick={() => { setAba(a.id); setEditando(null); setErro(null); }} style={{
              display: "flex", alignItems: "center", gap: 7, height: 38,
              background: "none", border: "none", padding: 0,
              fontSize: 12.5, fontWeight: aba === a.id ? 600 : 500,
              color: aba === a.id ? "var(--ink)" : "var(--ink-fraco)",
              boxShadow: aba === a.id ? "inset 0 -2px 0 var(--acento)" : "none",
            }}>
              <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d={a.icone} />
              </svg>
              {a.rotulo}
            </button>
          ))}
        </div>
      </div>

      {/*
        O script fica ACIMA das abas, sempre visível.
        Ele estava dentro de Webhooks, e é o item mais pedido da tela inteira —
        quem abre Integrações quase sempre veio buscar exatamente isto. Item
        mais usado não se esconde atrás de uma aba.
      */}
      {site && (
        <div style={{ padding: "18px 24px 0" }}>
          <div style={{
            background: "var(--painel)", border: "1px solid var(--acento)",
            borderRadius: 8, padding: "16px 18px", maxWidth: 1100,
          }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
              <span style={{ fontWeight: 600, fontSize: 13.5 }}>Script de rastreamento</span>
              <span style={{ fontSize: 11.5, color: "var(--ink-tenue)" }}>
                cole antes do <span className="num">&lt;/head&gt;</span> em todas as páginas
              </span>
            </div>
            <div style={{ fontSize: 11.5, color: "var(--ink-fraco)", marginBottom: 12, lineHeight: 1.5 }}>
              O mesmo código serve para quantas páginas e domínios você quiser — a loja é
              identificada pela chave, não pelo endereço. Landing, página de vendas e
              obrigado usam este mesmo trecho.
            </div>
            <Copiavel valor={
              `<script>window.RRTrackConfig={siteKey:"${site.chave}",endpoint:"${base}/rr/collect"}</script><script src="${base}/rr.js" async></script>`
            } />
          </div>
        </div>
      )}

      <div style={{ padding: 24, flexGrow: 1 }}>
        {erro && (
          <div style={{
            background: "var(--negativo-fundo)", border: "1px solid var(--negativo)",
            borderRadius: 6, padding: "10px 14px", marginBottom: 16,
            fontSize: 12.5, color: "var(--negativo)", maxWidth: 700,
          }}>{erro}</div>
        )}

        {/* ------------------------------------------------- ANÚNCIOS -- */}
        {aba === "anuncios" && (
          <div style={{ display: "grid", gap: 12, maxWidth: 780 }}>
            <p style={{ fontSize: 12.5, color: "var(--ink-fraco)", margin: "0 0 4px", maxWidth: 620 }}>
              Conecte as contas de onde vem o <strong style={{ color: "var(--ink-medio)" }}>gasto</strong>.
              Sem elas o painel tem faturamento e lucro, mas não tem ROAS — não há com o que dividir.
            </p>

            {PLATAFORMAS.map((p) => {
              const conta = contas.find((c) => c.plataforma === p.id && c.ativo);
              const aberto = editando === `conta:${p.id}`;

              return (
                <div key={p.id} style={{
                  background: "var(--painel)", border: "1px solid var(--linha)", borderRadius: 8,
                }}>
                  <div style={{
                    display: "flex", alignItems: "center", gap: 12, padding: "14px 18px",
                  }}>
                    <span style={{
                      width: 30, height: 30, borderRadius: 7, flexShrink: 0,
                      background: p.cor + "22", border: `1px solid ${p.cor}55`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      color: p.cor, fontWeight: 700, fontSize: 12,
                    }}>{p.nome[0]}</span>

                    <div style={{ flexGrow: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{p.nome}</div>
                      {conta ? (
                        <div className="num" style={{ fontSize: 11, color: "var(--ink-tenue)", marginTop: 2 }}>
                          conta {conta.externalId}
                        </div>
                      ) : (
                        <div style={{ fontSize: 11, color: "var(--ink-tenue)", marginTop: 2 }}>
                          não conectada
                        </div>
                      )}
                    </div>

                    {conta && <Selo ok>conectada</Selo>}

                    <Botao pequeno tipo="secundario"
                      onClick={() => { setEditando(aberto ? null : `conta:${p.id}`); setForm({}); }}>
                      {conta ? "editar" : "conectar"}
                    </Botao>
                  </div>

                  {aberto && (
                    <div style={{ padding: "0 18px 18px", borderTop: "1px solid var(--linha)", paddingTop: 16 }}>
                      <Campo rotulo="ID da conta de anúncio"
                        placeholder={p.id === "meta" ? "act_1234567890" : p.id === "google" ? "123-456-7890" : "1234567890"}
                        dica="É o identificador da conta no gerenciador, não o do pixel." {...campo("externalId")} />

                      {(CREDENCIAIS[p.id] ?? []).map((c) => (
                        <Campo key={c.chave} rotulo={c.rotulo + (c.opcional ? " (opcional)" : "")}
                          type={c.segredo ? "password" : "text"}
                          placeholder="cole aqui" dica={c.dica} {...campo(c.chave)} />
                      ))}

                      <Campo rotulo="Apelido (opcional)" placeholder="Conta principal" {...campo("label")} />

                      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                        <Botao disabled={salvando} onClick={() => salvar({
                          tipo: "conta_anuncio", plataforma: p.id,
                          externalId: form.externalId, label: form.label,
                          ...Object.fromEntries((CREDENCIAIS[p.id] ?? []).map((c) => [c.chave, form[c.chave]])),
                        })}>{salvando ? "salvando…" : "Salvar"}</Botao>
                        <Botao tipo="secundario" onClick={() => setEditando(null)}>Cancelar</Botao>
                        {conta && (
                          <button onClick={() => desativar("conta_anuncio", conta.id)} style={{
                            marginLeft: "auto", background: "none", border: "none",
                            color: "var(--negativo)", fontSize: 11.5,
                          }}>desconectar</button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ------------------------------------------------ WEBHOOKS -- */}
        {aba === "webhooks" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, maxWidth: 1100, alignItems: "start" }}>

            <Cartao titulo="Gateways de pagamento"
              descricao="De onde as vendas chegam. Cada um recebe uma URL própria.">
              {conexoes.filter((c) => c.ativo).map((c) => {
                const g = gatewaysDisponiveis.find((x) => x.id === c.gateway);
                return (
                  <div key={c.id} style={{
                    border: "1px solid var(--linha-forte)", borderRadius: 6,
                    padding: 14, marginBottom: 10,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10 }}>
                      <span style={{ fontWeight: 600, fontSize: 12.5, flexGrow: 1 }}>{g?.label ?? c.gateway}</span>
                      <Selo ok>ativo</Selo>
                      <button onClick={() => desativar("gateway", c.id)} style={{
                        background: "none", border: "none", color: "var(--ink-tenue)", fontSize: 11,
                      }}>remover</button>
                    </div>
                    {c.gateway === "api" ? (
                      <>
                        <Copiavel rotulo="Endereço para enviar a venda" valor={`${base}/api/pedidos/${c.segredo}`} />
                        <div style={{ fontSize: 11, color: "var(--ink-tenue)", marginTop: 8, lineHeight: 1.55 }}>
                          Para gateway sem integração pronta, ERP ou checkout próprio.
                          Seu servidor manda um POST com a venda; o resto do caminho é o
                          mesmo dos outros.
                        </div>
                        <ExemploApi />
                      </>
                    ) : (
                      <>
                        <Copiavel rotulo="URL do webhook" valor={`${base}/api/webhook/${c.gateway}/${c.segredo}`} />
                        <div style={{ fontSize: 11, color: "var(--ink-tenue)", marginTop: 8 }}>
                          O identificador do clique volta em <span className="num">{g?.repasse}</span>
                          {c.gateway === "appmax" && " — a Appmax não devolve nada, então precisa da chamada de reivindicação"}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}

              {editando === "gateway:novo" ? (
                <div style={{ borderTop: "1px solid var(--linha)", paddingTop: 14, marginTop: 4 }}>
                  <label style={{ display: "block", marginBottom: 13 }}>
                    <span style={{
                      display: "block", fontSize: 10.5, letterSpacing: ".07em",
                      textTransform: "uppercase", color: "var(--ink-tenue)",
                      fontWeight: 600, marginBottom: 5,
                    }}>Gateway</span>
                    <select value={form.gateway ?? ""} onChange={(e) => setForm((f) => ({ ...f, gateway: e.target.value }))}>
                      <option value="">escolha…</option>
                      {gatewaysDisponiveis
                        .filter((g) => !conexoes.some((c) => c.gateway === g.id && c.ativo))
                        .map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
                    </select>
                  </label>
                  <Campo rotulo="Chave de API (opcional)" type="password"
                    dica="Só a Appmax exige, para buscar o comprador. Sem ela, ficam 5 chaves em vez de 9."
                    {...campo("apiKey")} />
                  <div style={{ display: "flex", gap: 8 }}>
                    <Botao disabled={salvando || !form.gateway} onClick={() => salvar({
                      tipo: "gateway", gateway: form.gateway,
                      clientId: form.apiKey, apiKey: form.apiKey,
                    })}>{salvando ? "salvando…" : "Adicionar"}</Botao>
                    <Botao tipo="secundario" onClick={() => setEditando(null)}>Cancelar</Botao>
                  </div>
                </div>
              ) : (
                <Botao onClick={() => { setEditando("gateway:novo"); setForm({}); }}>Adicionar gateway</Botao>
              )}
            </Cartao>

            <Cartao titulo="Seu site"
              descricao="A chave que identifica este site no coletor.">
              {site ? (
                <>
                  <div style={{ marginBottom: 14 }}>
                    <div style={{
                      fontSize: 10.5, letterSpacing: ".07em", textTransform: "uppercase",
                      color: "var(--ink-tenue)", fontWeight: 600, marginBottom: 5,
                    }}>Domínio</div>
                    <div className="num" style={{ fontSize: 12.5 }}>{site.dominio}</div>
                  </div>
                  <Copiavel rotulo="Chave do site" valor={site.chave} />
                  <div style={{
                    fontSize: 11, color: "var(--ink-tenue)", marginTop: 12, lineHeight: 1.5,
                  }}>
                    O script para colar está no topo desta tela. Esta chave é o que ele
                    carrega — quem tiver ela pode mandar evento para esta loja, então
                    trate como segredo de configuração, não como identificador público.
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12, color: "var(--ink-tenue)" }}>
                  Nenhum site cadastrado para esta loja.
                </div>
              )}
            </Cartao>
          </div>
        )}

        {/* ---------------------------------------------------- UTMs -- */}
        {aba === "utms" && (
          <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 12, maxWidth: 1100, alignItems: "start" }}>

            <Cartao titulo="Código de UTMs"
              descricao="Cole no campo de parâmetros de URL de cada plataforma. É isto que faz o ROAS por anúncio existir.">
              {Object.entries(modelosUtm).map(([id, m]) => (
                <div key={id} style={{ marginBottom: 18 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 9, marginBottom: 7 }}>
                    <span style={{ fontWeight: 600, fontSize: 12.5 }}>{m.rotulo}</span>
                  </div>
                  <Copiavel valor={m.modelo} />
                  <div style={{ fontSize: 11, color: "var(--ink-tenue)", marginTop: 6 }}>{m.nota}</div>
                </div>
              ))}

              <div style={{
                marginTop: 6, padding: "11px 13px", borderRadius: 6,
                background: "var(--alerta-fundo)", border: "1px solid var(--alerta)",
                fontSize: 11.5, color: "var(--ink-medio)", lineHeight: 1.5,
              }}>
                Trocar um destes depois que campanhas já rodaram quebra a continuidade do
                histórico: as vendas antigas ficam com a leitura antiga.
              </div>
            </Cartao>

            <GeradorUtm />
          </div>
        )}

        {/* --------------------------------------------------- PIXEL -- */}
        {aba === "pixel" && (
          <div style={{ display: "grid", gap: 12, maxWidth: 780 }}>
            <p style={{ fontSize: 12.5, color: "var(--ink-fraco)", margin: "0 0 4px", maxWidth: 620 }}>
              Para onde as conversões são enviadas. O RRTrack manda pelo servidor —
              <strong style={{ color: "var(--ink-medio)" }}> não instale o pixel da plataforma no site junto</strong>,
              ou os dois contariam a mesma venda.
            </p>

            {pixels.filter((p) => p.ativo).map((p) => {
              const plat = PLATAFORMAS.find((x) => x.id === p.plataforma);
              return (
                <div key={p.id} style={{
                  background: "var(--painel)", border: "1px solid var(--linha)",
                  borderRadius: 8, padding: "14px 18px",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                    <div style={{ flexGrow: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{p.label}</div>
                      <div className="num" style={{ fontSize: 11, color: "var(--ink-tenue)", marginTop: 2 }}>
                        {plat?.nome ?? p.plataforma} · {p.externalId}
                      </div>
                    </div>
                    {p.codigoTeste && <Selo ok={false}>teste {p.codigoTeste}</Selo>}
                    <Selo ok>ativo</Selo>
                    <button onClick={() => desativar("pixel", p.id)} style={{
                      background: "none", border: "none", color: "var(--ink-tenue)", fontSize: 11,
                    }}>remover</button>
                  </div>
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                    {(p.eventos ?? EVENTOS.filter((e) => e.padrao).map((e) => e.id)).map((ev) => (
                      <span key={ev} className="num" style={{
                        fontSize: 10, padding: "2px 6px", borderRadius: 3,
                        background: "var(--positivo-fundo)", color: "var(--positivo)",
                      }}>{ev}</span>
                    ))}
                  </div>
                </div>
              );
            })}

            {editando === "pixel:novo" ? (
              <Cartao titulo="Adicionar pixel">
                <label style={{ display: "block", marginBottom: 13 }}>
                  <span style={{
                    display: "block", fontSize: 10.5, letterSpacing: ".07em",
                    textTransform: "uppercase", color: "var(--ink-tenue)",
                    fontWeight: 600, marginBottom: 5,
                  }}>Plataforma</span>
                  <select value={form.plataforma ?? "meta"}
                    onChange={(e) => setForm((f) => ({ ...f, plataforma: e.target.value }))}>
                    {PLATAFORMAS.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
                  </select>
                </label>

                <Campo
                  rotulo={form.plataforma === "google" ? "ID da conta de anúncio" : "ID do pixel"}
                  placeholder={form.plataforma === "google" ? "123-456-7890" : "1342429849238924"}
                  dica={form.plataforma === "google"
                    ? "O Google recebe conversão na conta, não num pixel."
                    : "Na Meta é o ID do conjunto de dados, no Events Manager."}
                  {...campo("externalId")} />

                {form.plataforma === "google" ? (
                  <>
                    <Campo rotulo="Ação de conversão" placeholder="customers/123/conversionActions/456"
                      dica="Crie no Google Ads uma ação do tipo Importar → Cliques, e cole o nome do recurso dela."
                      {...campo("conversionAction")} />
                    {(CREDENCIAIS.google ?? []).map((c) => (
                      <Campo key={c.chave} rotulo={c.rotulo + (c.opcional ? " (opcional)" : "")}
                        type={c.segredo ? "password" : "text"}
                        placeholder="cole aqui" dica={c.dica} {...campo(c.chave)} />
                    ))}
                  </>
                ) : (
                  <Campo rotulo="Token da API de conversões" type="password" placeholder="cole aqui"
                    {...campo("token")} />
                )}
                <Campo rotulo="Apelido (opcional)" placeholder="Pixel principal" {...campo("label")} />
                <Campo rotulo="Código de teste (opcional)" placeholder="TEST12345"
                  dica="Com ele os eventos aparecem na aba de teste sem sujar os dados de produção."
                  {...campo("testEventCode")} />

                <div style={{ margin: "18px 0 13px" }}>
                  <div style={{
                    fontSize: 10.5, letterSpacing: ".07em", textTransform: "uppercase",
                    color: "var(--ink-tenue)", fontWeight: 600, marginBottom: 8,
                  }}>Eventos a enviar</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                    {EVENTOS.map((e) => {
                      const on = eventosSel.includes(e.id);
                      return (
                        <button key={e.id} onClick={() => setEventosSel((s) =>
                          on ? s.filter((x) => x !== e.id) : [...s, e.id])} style={{
                          padding: "5px 11px", borderRadius: 5, fontSize: 11.5, fontWeight: 500,
                          border: `1px solid ${on ? "var(--positivo)" : "var(--linha-forte)"}`,
                          background: on ? "var(--positivo-fundo)" : "transparent",
                          color: on ? "var(--positivo)" : "var(--ink-tenue)",
                        }}>{e.rotulo}</button>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--ink-tenue)", marginTop: 8, lineHeight: 1.5 }}>
                    Página vista vem desligado: é o de maior volume e o de menor valor para
                    otimização — uma chamada por página de cada visitante.
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <Botao disabled={salvando} onClick={() => salvar({
                    tipo: "pixel",
                    plataforma: form.plataforma ?? "meta",
                    externalId: form.externalId, token: form.token, label: form.label,
                    testEventCode: form.testEventCode,
                    conversionAction: form.conversionAction,
                    ...Object.fromEntries((CREDENCIAIS.google ?? []).map((c) => [c.chave, form[c.chave]])),
                    eventos: eventosSel,
                  })}>{salvando ? "salvando…" : "Salvar pixel"}</Botao>
                  <Botao tipo="secundario" onClick={() => setEditando(null)}>Cancelar</Botao>
                </div>
              </Cartao>
            ) : (
              <div><Botao onClick={() => { setEditando("pixel:novo"); setForm({}); }}>Adicionar pixel</Botao></div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------- gerador de UTM -- */

function GeradorUtm() {
  const [c, setC] = useState<Record<string, string>>({ utm_medium: "organico" });
  const set = (k: string) => ({
    value: c[k] ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setC((v) => ({ ...v, [k]: e.target.value })),
  });

  let url = "";
  try {
    if (c.url) {
      const u = new URL(c.url.startsWith("http") ? c.url : "https://" + c.url);
      for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) {
        if (c[k]) u.searchParams.set(k, c[k]!);
      }
      url = u.toString();
    }
  } catch { url = ""; }

  return (
    <Cartao titulo="Gerar link com UTM"
      descricao="Para tráfego que não é anúncio: bio, e-mail, parceiro.">
      <Campo rotulo="Endereço do site" placeholder="https://sualoja.com.br" {...set("url")} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
        <Campo rotulo="Origem" placeholder="bio" {...set("utm_source")} />
        <Campo rotulo="Meio" placeholder="instagram" {...set("utm_medium")} />
        <Campo rotulo="Campanha" placeholder="perfil" {...set("utm_campaign")} />
        <Campo rotulo="Conteúdo" placeholder="link-bio" {...set("utm_content")} />
      </div>

      {url ? <Copiavel rotulo="Link pronto" valor={url} /> : (
        <div style={{
          fontSize: 11.5, color: "var(--ink-tenue)", padding: "10px 12px",
          border: "1px dashed var(--linha-forte)", borderRadius: 5,
        }}>Preencha o endereço para gerar o link.</div>
      )}

      <div style={{ fontSize: 11, color: "var(--ink-tenue)", marginTop: 12, lineHeight: 1.5 }}>
        Origem que não é anúncio não vira estrutura de campanha — a venda entra como
        orgânica, sem ficar pendurada num anúncio que não existe.
      </div>
    </Cartao>
  );
}
