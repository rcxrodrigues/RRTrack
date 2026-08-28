"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/*
 * Ligar a loja da Shopify, e trazer o catálogo dela para dentro da oferta.
 *
 * São duas telas com públicos diferentes no tempo: a conexão se faz uma vez e
 * nunca mais se olha; o seletor de produto se usa toda vez que uma oferta
 * nasce. Por isso a primeira é discreta e recolhida, e o segundo é um modal com
 * busca — o que se repete tem que ser rápido.
 *
 * O token nunca volta do servidor. A tela sabe que existe conexão e sabe o nome
 * da loja; a credencial em si entra uma vez e fica cifrada. Uma tela que
 * recebesse o token de volta o deixaria no navegador de toda sessão aberta, e
 * ele cria pedido e lê o cadastro inteiro de clientes.
 */

export interface ConexaoShopify {
  id: string;
  shopDomain: string;
  label: string;
  active: boolean;
}

export interface VarianteEscolhida {
  shopifyVariantId: string;
  nome: string;
  sku: string;
  precoCents: number;
}

const emReais = (c: number): string => (c / 100).toFixed(2).replace(".", ",");

/* ------------------------------------------------------------- conexão -- */

export function PainelShopify({ tenantId, conexoes }: {
  tenantId: string;
  conexoes: ConexaoShopify[];
}) {
  const router = useRouter();
  const [abrindo, setAbrindo] = useState(false);
  const [dominio, setDominio] = useState("");
  const [token, setToken] = useState("");
  const [erro, setErro] = useState("");
  const [salvando, setSalvando] = useState(false);

  const ligada = conexoes[0];

  async function ligar() {
    setErro("");
    setSalvando(true);
    try {
      const r = await fetch("/api/shopify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId, dominio, token }),
      });
      const j = await r.json() as { erro?: string };
      if (!r.ok) { setErro(j.erro ?? "não deu para ligar"); return; }
      setDominio(""); setToken(""); setAbrindo(false);
      router.refresh();
    } catch {
      setErro("falha de rede");
    } finally {
      setSalvando(false);
    }
  }

  async function desligar() {
    if (!ligada) return;
    /* Confirmação porque desligar não apaga pedido nenhum, mas para de criar
       os próximos — e o sintoma disso é silencioso. */
    if (!confirm(`Desligar "${ligada.label}"?\n\nOs pedidos pagos daqui em diante deixam de ser criados na Shopify.`)) return;

    await fetch(`/api/shopify?tenantId=${tenantId}&id=${ligada.id}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <div style={{
      background: "var(--painel)", border: "1px solid var(--linha)",
      borderRadius: 8, padding: 16, marginBottom: 20,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Loja da Shopify</span>

        {ligada ? (
          <>
            <span style={{
              fontSize: 11, padding: "2px 8px", borderRadius: 20,
              background: "var(--positivo-fundo)", color: "var(--positivo)", fontWeight: 600,
            }}>
              {ligada.label}
            </span>
            <span style={{ fontSize: 11.5, color: "var(--ink-tenue)" }}>{ligada.shopDomain}</span>
            <button onClick={desligar} style={botaoTenue}>desligar</button>
          </>
        ) : (
          <>
            <span style={{ fontSize: 11.5, color: "var(--ink-tenue)" }}>
              nenhuma ligada — o pedido pago não vai para lugar nenhum
            </span>
            {!abrindo && (
              <button onClick={() => setAbrindo(true)} style={botaoTenue}>ligar</button>
            )}
          </>
        )}
      </div>

      {abrindo && !ligada && (
        <div style={{ marginTop: 14, display: "grid", gap: 10, maxWidth: 520 }}>
          {/*
            As instruções ficam aqui e não num link de ajuda porque o caminho no
            admin da Shopify tem cinco cliques e ninguém decora. Errar o escopo
            é o erro mais comum, e ele só aparece na primeira venda.
          */}
          <div style={{
            fontSize: 11.5, lineHeight: 1.6, color: "var(--ink-medio)",
            background: "var(--fundo)", border: "1px solid var(--linha)",
            borderRadius: 6, padding: "10px 12px",
          }}>
            No admin da Shopify: <strong>Configurações → Apps e canais de vendas →
            Desenvolver apps → Criar um app</strong>.
            <br />
            Em <strong>Escopos da Admin API</strong>, marque{" "}
            <code style={codigo}>read_products</code>,{" "}
            <code style={codigo}>write_orders</code> e{" "}
            <code style={codigo}>write_customers</code>.
            <br />
            Instale o app e copie o <strong>token de acesso</strong> — ele aparece
            uma única vez.
          </div>

          <label style={rotulo}>
            Domínio da loja
            <input
              value={dominio}
              onChange={(e) => setDominio(e.target.value)}
              placeholder="minhaloja.myshopify.com"
              style={entrada}
            />
          </label>

          <label style={rotulo}>
            Token de acesso da Admin API
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="shpat_..."
              type="password"
              style={entrada}
            />
          </label>

          {erro && (
            <div style={{
              fontSize: 12, color: "var(--negativo)", background: "var(--negativo-fundo)",
              padding: "8px 10px", borderRadius: 6, lineHeight: 1.5,
            }}>{erro}</div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={ligar} disabled={salvando || !dominio || !token} style={botaoPrimario}>
              {salvando ? "conferindo..." : "Ligar loja"}
            </button>
            <button onClick={() => { setAbrindo(false); setErro(""); }} style={botaoTenue}>
              cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------ seletor de item -- */

interface Produto {
  id: string;
  titulo: string;
  status: string;
  variantes: Array<{ id: string; titulo: string; sku: string | null; precoCents: number; disponivel: boolean }>;
}

export function SeletorDeProduto({ tenantId, conexaoId, aoEscolher, aoFechar }: {
  tenantId: string;
  conexaoId: string;
  aoEscolher: (v: VarianteEscolhida) => void;
  aoFechar: () => void;
}) {
  const [busca, setBusca] = useState("");
  const [produtos, setProdutos] = useState<Produto[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");

  useEffect(() => {
    let cancelado = false;

    /*
     * Espera a digitação parar antes de consultar. Sem isso, cada tecla vira
     * uma chamada à Shopify, e ela limita chamadas por segundo — a busca ficaria
     * mais lenta quanto mais rápido a pessoa digitasse.
     */
    const t = setTimeout(async () => {
      setCarregando(true);
      setErro("");
      try {
        const url = `/api/shopify?tenantId=${tenantId}&conexaoId=${conexaoId}`
          + (busca ? `&busca=${encodeURIComponent(busca)}` : "");
        const r = await fetch(url);
        const j = await r.json() as { produtos?: Produto[]; erro?: string };
        if (cancelado) return;
        if (!r.ok) { setErro(j.erro ?? "não deu para buscar"); setProdutos([]); return; }
        setProdutos(j.produtos ?? []);
      } catch {
        if (!cancelado) setErro("falha de rede");
      } finally {
        if (!cancelado) setCarregando(false);
      }
    }, busca ? 350 : 0);

    return () => { cancelado = true; clearTimeout(t); };
  }, [tenantId, conexaoId, busca]);

  return (
    <div
      onClick={aoFechar}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,.45)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: 24, zIndex: 60, overflowY: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--painel)", border: "1px solid var(--linha)",
          borderRadius: 10, width: "100%", maxWidth: 560, marginTop: 40,
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--linha)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
            Importar produto da Shopify
          </div>
          <input
            autoFocus
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="buscar pelo nome..."
            style={{ ...entrada, marginTop: 0 }}
          />
        </div>

        <div style={{ maxHeight: "55vh", overflowY: "auto" }}>
          {carregando && (
            <div style={vazio}>buscando...</div>
          )}

          {!carregando && erro && (
            <div style={{ ...vazio, color: "var(--negativo)" }}>{erro}</div>
          )}

          {!carregando && !erro && produtos.length === 0 && (
            <div style={vazio}>nenhum produto encontrado</div>
          )}

          {!carregando && !erro && produtos.map((p) => (
            <div key={p.id} style={{ borderBottom: "1px solid var(--linha)" }}>
              <div style={{
                padding: "10px 16px 4px", fontSize: 12.5, fontWeight: 600,
                display: "flex", alignItems: "center", gap: 8,
              }}>
                {p.titulo}
                {/*
                  Produto em rascunho não pode ser vendido: a Shopify aceita o
                  pedido, mas o item não está publicado. Avisar aqui evita
                  descobrir isso pelo comprador.
                */}
                {p.status !== "ACTIVE" && (
                  <span style={{
                    fontSize: 10, padding: "1px 6px", borderRadius: 20,
                    background: "var(--alerta-fundo)", color: "var(--alerta)", fontWeight: 600,
                  }}>{p.status === "DRAFT" ? "rascunho" : p.status.toLowerCase()}</span>
                )}
              </div>

              {p.variantes.map((v) => (
                <button
                  key={v.id}
                  onClick={() => {
                    aoEscolher({
                      shopifyVariantId: v.id,
                      /* Variante única da Shopify se chama "Default Title" — pôr
                         isso no nome do item deixaria o comprador confuso. */
                      nome: v.titulo && v.titulo !== "Default Title"
                        ? `${p.titulo} — ${v.titulo}` : p.titulo,
                      sku: v.sku ?? "",
                      precoCents: v.precoCents,
                    });
                    aoFechar();
                  }}
                  style={{
                    display: "flex", width: "100%", alignItems: "center", gap: 10,
                    padding: "7px 16px", background: "none", border: "none",
                    cursor: "pointer", textAlign: "left", fontSize: 12,
                    color: "var(--ink-medio)",
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {v.titulo && v.titulo !== "Default Title" ? v.titulo : "variante única"}
                    {v.sku && (
                      <span style={{ color: "var(--ink-tenue)", marginLeft: 8 }}>{v.sku}</span>
                    )}
                  </span>
                  {!v.disponivel && (
                    <span style={{ fontSize: 10.5, color: "var(--ink-tenue)" }}>sem estoque</span>
                  )}
                  <span className="num" style={{ fontWeight: 600, color: "var(--ink)" }}>
                    R$ {emReais(v.precoCents)}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>

        <div style={{ padding: "10px 16px", borderTop: "1px solid var(--linha)", textAlign: "right" }}>
          <button onClick={aoFechar} style={botaoTenue}>fechar</button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- pedacinhos -- */

const entrada: React.CSSProperties = {
  width: "100%", marginTop: 4, padding: "8px 10px",
  background: "var(--fundo)", border: "1px solid var(--linha-forte)",
  borderRadius: 6, color: "var(--ink)", fontSize: 13,
};

const rotulo: React.CSSProperties = {
  fontSize: 11.5, color: "var(--ink-fraco)", fontWeight: 600, display: "block",
};

const botaoTenue: React.CSSProperties = {
  background: "none", border: "1px solid var(--linha-forte)", borderRadius: 6,
  padding: "4px 10px", fontSize: 11.5, color: "var(--ink-fraco)", cursor: "pointer",
};

const botaoPrimario: React.CSSProperties = {
  background: "var(--acento)", border: "none", borderRadius: 6,
  padding: "8px 14px", fontSize: 12.5, color: "#fff", fontWeight: 600, cursor: "pointer",
};

const codigo: React.CSSProperties = {
  background: "var(--painel)", border: "1px solid var(--linha)",
  borderRadius: 4, padding: "1px 5px", fontSize: 11,
};

const vazio: React.CSSProperties = {
  padding: "28px 16px", textAlign: "center", fontSize: 12, color: "var(--ink-tenue)",
};
