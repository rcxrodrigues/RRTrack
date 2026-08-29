"use client";

import { Fragment, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { LojaDoUsuario } from "@/core/auth";
import { TaxasDoGateway } from "./taxas-gateway";
import { LogoPlataforma } from "./logos";
import { MetaVincular } from "./meta-vincular";

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
  /* Tabela de taxas por método de pagamento — ver core/taxas.ts. */
  taxas: Record<string, unknown>;
}
interface Pixel {
  id: string; plataforma: string; externalId: string; label: string;
  ativo: boolean; codigoTeste: string | null;
  eventos: string[] | null; textoBotao: string | null;
}

const PLATAFORMAS = [
  { id: "meta", nome: "Meta Ads", cor: "#4A7BC8" },
  { id: "google", nome: "Google Ads", cor: "#D6A344" },
  { id: "tiktok", nome: "TikTok Ads", cor: "#45C4D0" },
];

/*
 * Cada plataforma pede credencial diferente, e a diferença não é cosmética.
 *
 * O TikTok aceita um token longo e pronto. O Google exige OAuth2 — refresh
 * token trocado por acesso a cada hora — mais um developer token que ELE
 * precisa aprovar, o que leva dias. Mostrar os mesmos dois campos para os dois
 * faria o cadastro do Google parecer completo e não funcionar.
 *
 * A Meta saiu daqui: o login com o Facebook cobre o caso inteiro, e manter o
 * campo manual ao lado dele só criava dúvida sobre qual caminho é o certo.
 */
const CREDENCIAIS: Record<string, Array<{
  chave: string; rotulo: string; dica?: string; segredo?: boolean; opcional?: boolean;
}>> = {
  tiktok: [
    { chave: "accessToken", rotulo: "Access token", segredo: true,
      dica: "TikTok Ads Manager → Ferramentas → Events API, ou no portal de desenvolvedor." },
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
      {/*
        * Um campo type="password" ao lado de um campo de texto faz o navegador
        * concluir que isto e uma tela de login e preencher os dois com o
        * e-mail e a senha salvos. Ja aconteceu: o formulario apareceu com a
        * senha da pessoa no lugar do token, a um clique de ser gravada como
        * credencial da conta de anuncio.
        */}
      <input autoComplete={resto.type === "password" ? "new-password" : "off"}
        data-1p-ignore data-lpignore="true" {...resto} />
      {dica && (
        <span style={{ display: "block", fontSize: 11, color: "var(--ink-tenue)", marginTop: 4 }}>
          {dica}
        </span>
      )}
    </label>
  );
}

/*
 * Os perfis do Facebook desta loja, e como adicionar outro.
 *
 * A ordem da tela é a ordem da decisão: primeiro QUEM autoriza (o perfil),
 * depois O QUE daquele perfil pertence a esta loja (as contas e os pixels).
 * Inverter isso obriga a pessoa a escolher contas antes de dizer de onde elas
 * vêm — foi por isso que a escolha saiu de uma página separada e desceu para
 * dentro deste cartão.
 *
 * Não há mais cadastro manual de token para a Meta. Ele existia para quem usa
 * usuário de sistema do Business Manager, mas dois caminhos com o mesmo peso
 * lado a lado só produziam dúvida sobre qual é o certo — e o campo de senha
 * ainda fazia o navegador oferecer a senha salva no lugar do token.
 */
function PerfisDaMeta({ tenantId, perfil }: {
  tenantId: string;
  perfil: { nome: string; expiraEm: string | null } | null;
}) {
  const erro = useSearchParams().get("meta_erro");
  const [escolhendo, setEscolhendo] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [gerando, setGerando] = useState(false);
  const [copiado, setCopiado] = useState(false);

  async function gerarLink() {
    setGerando(true);
    const r = await fetch("/api/meta/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId }),
    }).catch(() => null);

    const j = r ? await r.json().catch(() => null) : null;
    setLink(r?.ok && j?.url ? j.url : null);
    setGerando(false);

    if (j?.url) {
      navigator.clipboard?.writeText(j.url).then(() => setCopiado(true)).catch(() => {});
    }
  }

  return (
    <>
      <div style={{ fontSize: 11.5, color: "var(--ink-tenue)", marginBottom: 10 }}>
        Conecte seus perfis por aqui:
      </div>

      {perfil && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          border: "1px solid var(--linha-forte)", borderRadius: 6,
          padding: "10px 12px", marginBottom: 10,
        }}>
          <LogoPlataforma id="meta" tamanho={22} />
          <div style={{ flexGrow: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600 }}>{perfil.nome}</div>
            {perfil.expiraEm && (
              <div style={{ fontSize: 11, color: "var(--ink-tenue)", marginTop: 1 }}>
                autorização vale até {new Date(perfil.expiraEm).toLocaleDateString("pt-BR")}
              </div>
            )}
          </div>
          <Selo ok>ativo</Selo>
        </div>
      )}

      {erro && (
        <div style={{ fontSize: 11.5, color: "var(--negativo)", marginBottom: 10 }}>{erro}</div>
      )}

      <Botao pequeno tipo="secundario" onClick={() => { setEscolhendo(true); setLink(null); }}>
        {perfil ? "Adicionar perfil" : "Conectar perfil"}
      </Botao>

      {/*
        * O popup existe porque a escolha entre "aqui" e "em outro navegador" é
        * uma bifurcação, não uma opção secundária: quem trabalha em antidetect
        * erraria o caminho todas as vezes se o segundo fosse um link discreto.
        */}
      {escolhendo && (
        <div
          onClick={() => setEscolhendo(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 40,
            background: "rgba(0,0,0,.55)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
          }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: "var(--painel)", border: "1px solid var(--linha-forte)",
            borderRadius: 10, padding: 26, width: "min(400px, 100%)", textAlign: "center",
          }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
              <LogoPlataforma id="meta" tamanho={34} />
            </div>

            <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 5px" }}>Conectar Meta Ads</h2>
            <p style={{ fontSize: 12, color: "var(--ink-tenue)", margin: "0 0 18px" }}>
              Escolha como deseja conectar sua conta
            </p>

            <a href={`/api/meta/conectar?tenantId=${tenantId}`} style={{
              display: "block", padding: "11px 16px", borderRadius: 6,
              background: "#1877F2", color: "#fff", textDecoration: "none",
              fontWeight: 600, fontSize: 12.5,
            }}>Continuar neste navegador</a>
            <div style={{ fontSize: 11, color: "var(--ink-tenue)", margin: "6px 0 14px" }}>
              Conecte diretamente, com o perfil que já está aberto aqui
            </div>

            <button onClick={gerarLink} disabled={gerando} style={{
              display: "block", width: "100%", padding: "11px 16px", borderRadius: 6,
              background: "transparent", border: "1px solid var(--linha-forte)",
              color: "var(--ink)", fontWeight: 600, fontSize: 12.5,
            }}>{gerando ? "gerando…" : "Copiar link para navegador multilogin"}</button>
            <div style={{ fontSize: 11, color: "var(--ink-tenue)", marginTop: 6 }}>
              Gere um link para conectar em outro navegador ou compartilhar com colaboradores
            </div>

            {link && (
              <div style={{ marginTop: 14, textAlign: "left" }}>
                <div className="num" style={{
                  fontSize: 10.5, padding: "8px 10px", borderRadius: 5,
                  background: "var(--fundo)", border: "1px solid var(--linha)",
                  wordBreak: "break-all", color: "var(--ink-fraco)",
                }}>{link}</div>
                <div style={{ fontSize: 11, color: "var(--ink-tenue)", marginTop: 5 }}>
                  {copiado ? "Copiado. " : ""}Vale 30 minutos. Abre em qualquer navegador.
                </div>
              </div>
            )}

            <button onClick={() => setEscolhendo(false)} style={{
              marginTop: 16, background: "none", border: "none",
              fontSize: 11.5, color: "var(--ink-tenue)",
            }}>fechar</button>
          </div>
        </div>
      )}

      {perfil && (
        <div style={{ marginTop: 16, borderTop: "1px solid var(--linha)", paddingTop: 4 }}>
          <MetaVincular embutido />
        </div>
      )}
    </>
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

function Copiavel({ valor, rotulo, multilinha }: {
  valor: string;
  rotulo?: string;
  /*
   * Sem isto o bloco de várias linhas sai numa linha só: `nowrap` colapsa a
   * quebra, e o que aparece na tela deixa de parecer com o que se cola.
   */
  multilinha?: boolean;
}) {
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
          overflowX: "auto",
          whiteSpace: multilinha ? "pre" : "nowrap",
          lineHeight: multilinha ? 1.65 : undefined,
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
            O token vai no cabeçalho{" "}
            <span className="num">Authorization: Bearer &lt;token&gt;</span> ou{" "}
            <span className="num">x-api-token</span> — e vive no seu servidor, nunca em
            código de navegador.<br />
            Data sem fuso escrito é lida como UTC (<span className="num">2026-08-20 23:30:00</span>).
            Mande com fuso se for hora local.<br />
            <strong style={{ color: "var(--ink-medio)" }}>isTest: true</strong> valida e
            devolve o que entendeu, sem gravar nada.<br />
            O formato da Utmify também é aceito inteiro —{" "}
            <span className="num">orderId</span>, <span className="num">commission</span>,{" "}
            <span className="num">trackingParameters</span>,{" "}
            <span className="num">priceInCents</span>. Quem já integra com eles aponta
            para cá sem mexer no código, e ganha os campos que eles não têm: CEP,
            cidade, estado, nascimento e gênero, que viram chave de correspondência
            a mais na Meta.
          </div>
        </>
      )}
    </div>
  );
}

/*
 * A chave de API de um gateway já conectado.
 *
 * Existia um buraco: a tela só oferecia o campo de chave ao ADICIONAR o
 * gateway, e escondia do menu quem já estava ativo. Quem conectou sem chave —
 * que é o caminho natural, porque o webhook funciona sem ela — não tinha como
 * acrescentar depois sem remover e refazer.
 *
 * E a chave não é detalhe em gateway que não assina o webhook. Sem ela a venda
 * entra sem confirmação: qualquer um que descubra a URL insere uma venda que
 * não houve, e dispara uma conversão falsa que a Meta usa para otimizar.
 */
/*
 * Gateways que assinam o webhook com segredo próprio.
 *
 * Esse segredo NÃO é a chave de API: ele é gerado quando se cria o endpoint no
 * painel do gateway e serve só para provar que o webhook veio de lá. Sem ele
 * cadastrado, a venda entra sem verificação — funciona, mas o painel não tem
 * como distinguir o que está provado do que está só plausível.
 */
const ASSINAM_WEBHOOK: Record<string, { rotulo: string; dica: string }> = {
  millions: {
    rotulo: "Segredo de assinatura do webhook (opcional)",
    dica: "Não fica na tela de chaves de API — a MillionsPay mostra ao CRIAR o endpoint de webhook, uma vez só. Em branco, a venda entra normalmente, apenas sem verificação de origem.",
  },
};

function ChaveDeApi({
  conexao, aberto, abrir, fechar, valor, mudou, salvando, gravar,
  assinatura, mudouAssinatura,
}: {
  conexao: Conexao;
  aberto: boolean;
  abrir: () => void;
  fechar: () => void;
  valor: string;
  mudou: (v: string) => void;
  salvando: boolean;
  gravar: () => void;
  assinatura: string;
  mudouAssinatura: (v: string) => void;
}) {
  const assina = ASSINAM_WEBHOOK[conexao.gateway];

  if (aberto) {
    return (
      <div style={{ marginTop: 11, paddingTop: 11, borderTop: "1px solid var(--linha)" }}>
        <Campo
          rotulo={conexao.temCredencial ? "Trocar a chave de API" : "Chave de API"}
          type="password"
          placeholder="cole a chave do painel do gateway"
          dica="Use a chave SECRETA, não a pública — o RRTrack chama a API pelo servidor. Fica cifrada em repouso e nunca volta para a tela."
          value={valor}
          onChange={(e) => mudou(e.target.value)}
        />
        {assina && (
          <Campo
            rotulo={assina.rotulo}
            type="password"
            placeholder="cole o segredo do endpoint"
            dica={assina.dica}
            value={assinatura}
            onChange={(e) => mudouAssinatura(e.target.value)}
          />
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <Botao disabled={salvando || (!valor && !assinatura)} onClick={gravar}>
            {salvando ? "salvando…" : "Salvar"}
          </Botao>
          <Botao tipo="secundario" onClick={fechar}>Cancelar</Botao>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      marginTop: 9, fontSize: 11,
    }}>
      {conexao.temCredencial ? (
        <>
          <Selo ok>chave de API</Selo>
          <span style={{ color: "var(--ink-tenue)" }}>venda confirmada na origem</span>
        </>
      ) : (
        <>
          <Selo ok={false}>sem chave de API</Selo>
          <span style={{ color: "var(--ink-tenue)" }}>a venda entra sem confirmação</span>
        </>
      )}
      <button onClick={abrir} style={{
        background: "none", border: "none", padding: 0, cursor: "pointer",
        color: "var(--acento)", fontSize: 11, fontWeight: 600, marginLeft: "auto",
      }}>
        {conexao.temCredencial ? "trocar" : "adicionar"}
      </button>
    </div>
  );
}

export function Integracoes({
  loja, base, site, contas, conexoes, pixels, gatewaysDisponiveis, modelosUtm, perfilMeta,
}: {
  perfilMeta: { nome: string; expiraEm: string | null } | null;
  loja: LojaDoUsuario;
  base: string;
  site: {
    dominio: string;
    chave: string;
    config: {
      viewContentOnLoad?: boolean;
      productId?: string;
      productName?: string;
      productPriceCents?: number;
    };
  } | null;
  contas: Conta[];
  conexoes: Conexao[];
  pixels: Pixel[];
  gatewaysDisponiveis: Array<{
    id: string; label: string; repasse: string;
    especie: "plataforma" | "gateway" | "api";
    /* O que pedir no formulário — declarado pelo adaptador, ver gateways/types.ts. */
    credenciais: Array<{ chave: string; rotulo: string; dica?: string; obrigatoria?: boolean }>;
  }>;
  modelosUtm: Record<string, { rotulo: string; modelo: string; nota: string }>;
}) {
  const router = useRouter();
  const [aba, setAba] = useState<Aba>("anuncios");
  const [editando, setEditando] = useState<string | null>(null);
  const [expandida, setExpandida] = useState<string | null>(null);
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

  /*
   * A lista de conexoes de uma ou mais especies.
   *
   * E funcao, e nao JSX repetido, porque a mesma linha aparece em dois
   * cartoes: "Webhooks" e "Credenciais de API". Duas copias de cem linhas
   * divergiriam, e a divergencia apareceria como um cartao ganhando um aviso
   * que o outro nao tem.
   */
  const listaDeConexoes = (especies: readonly string[]) => {
            /*
             * Sem subtitulo por especie dentro da lista.
             *
             * Eu tinha posto "PLATAFORMAS DE VENDA" e "GATEWAYS DE PAGAMENTO"
             * separando as linhas. E invencao minha: o lojista le esta tela
             * num vocabulario que ja conhece de outra ferramenta, e taxonomia
             * nova aqui so obriga a traduzir. A distincao ficou onde serve
             * para escolher — no menu de adicionar.
             */
            const especieDe = (gw: string) =>
              gatewaysDisponiveis.find((x) => x.id === gw)?.especie ?? "gateway";

            const ativas = conexoes.filter(
              (c) => c.ativo && especies.includes(especieDe(c.gateway)),
            );

            return ativas.map((c) => {
            const g = gatewaysDisponiveis.find((x) => x.id === c.gateway);
            const esp = especieDe(c.gateway);
            return (
              <Fragment key={c.id}>
              <div style={{
                border: "1px solid var(--linha-forte)", borderRadius: 6,
                padding: 14, marginBottom: 10,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10 }}>
            {/*
              Marca e nome próprio, quando há nome próprio.

              Podendo existir duas da mesma marca, "Shopify" repetido duas
              vezes não diz qual é a loja de fora — e na hora de remover uma,
              a escolha vira sorteio.
            */}
            {(() => {
              const marca = g?.label ?? c.gateway;
              const proprio = c.label && c.label !== marca && c.label !== c.gateway
                ? c.label : null;
              return (
                <span style={{ display: "flex", alignItems: "baseline", gap: 7, flexGrow: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 600, fontSize: 12.5 }}>{marca}</span>
                  {proprio && (
                    <span style={{
                      fontSize: 11, color: "var(--ink-tenue)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>{proprio}</span>
                  )}
                </span>
              );
            })()}
                  <Selo ok>ativo</Selo>
                  <button onClick={() => desativar("gateway", c.id)} style={{
                    background: "none", border: "none", color: "var(--ink-tenue)", fontSize: 11,
                  }}>remover</button>
                </div>
                {/* Pela espécie, e não pelo id: hoje há dois leitores genéricos
                    — a credencial de API e o webhook de plataforma nova — e
                    comparar com "api" mandaria o segundo para o cartão errado. */}
                {esp === "api" ? (
                  <>
                    {/*
                      Endereço e token separados, e o token num campo próprio.

                      Antes era uma URL só, com o segredo no caminho. Funciona,
                      e é o jeito errado de entregar credencial de API: URL
                      aparece em log de servidor, log de proxy, cabeçalho
                      Referer e histórico de navegador. Cabeçalho de
                      autorização não aparece em nenhum desses por acidente.

                      A URL antiga continua valendo, para quem já configurou.
                    */}
                    <Copiavel rotulo="Endereço" valor={`${base}/api/pedidos`} />
                    <div style={{ marginTop: 8 }}>
                      <Copiavel rotulo="Token" valor={c.segredo} />
                    </div>
                    <div style={{ fontSize: 11, color: "var(--ink-tenue)", marginTop: 8, lineHeight: 1.55 }}>
                      Para gateway sem integração pronta, ERP ou checkout próprio.
                      Seu servidor manda um POST com a venda, com o token em
                      <span className="num"> Authorization: Bearer</span>; o resto do
                      caminho é o mesmo dos outros.
                    </div>
                    <ExemploApi />
                  </>
                ) : (
                  <>
                    <Copiavel rotulo="URL do webhook" valor={`${base}/api/webhook/${c.gateway}/${c.segredo}`} />
                    <div style={{ fontSize: 11, color: "var(--ink-tenue)", marginTop: 8 }}>
                      O identificador do clique volta em <span className="num">{g?.repasse}</span>
                      {c.gateway === "appmax" && " — a Appmax não devolve nada, então precisa da chamada de reivindicação"}
                      {/*
                        A Shopify devolve o campo, mas ele chega vazio se o
                        tema não puser nada nele. E aí a venda entra normal,
                        só que sem origem — falha que não dá erro nenhum e
                        que só aparece quando alguém estranha que nenhuma
                        venda tem campanha.
                      */}
                      {c.gateway === "shopify" && (
                        <> — o tema precisa gravar o clickId em <span className="num">note_attributes</span> do
                        carrinho; sem isso a venda entra sem origem</>
                      )}
                    </div>
                    <ChaveDeApi
                      conexao={c}
                      aberto={editando === `chave:${c.gateway}`}
                      abrir={() => { setEditando(`chave:${c.gateway}`); setForm({}); }}
                      fechar={() => setEditando(null)}
                      valor={form.apiKey ?? ""}
                      mudou={(v) => setForm((f) => ({ ...f, apiKey: v }))}
                      assinatura={form.signingSecret ?? ""}
                      mudouAssinatura={(v) => setForm((f) => ({ ...f, signingSecret: v }))}
                      salvando={salvando}
                      gravar={() => salvar({
                        /* Pelo id: com duas do mesmo gateway, gravar por marca
                           escreveria na conexão errada. */
                        tipo: "gateway", id: c.id, gateway: c.gateway,
                        apiKey: form.apiKey, clientId: form.apiKey,
                        signingSecret: form.signingSecret,
                      })}
                    />
                    <TaxasDoGateway
                      taxas={c.taxas}
                      aberto={editando === `taxas:${c.gateway}`}
                      abrir={() => setEditando(`taxas:${c.gateway}`)}
                      fechar={() => setEditando(null)}
                      salvando={salvando}
                      gravar={(taxas) => salvar({ tipo: "taxas", id: c.id, gateway: c.gateway, taxas })}
                    />
                  </>
                )}
              </div>
              </Fragment>
            );
            });
  };

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
            {/*
              O comentário com o domínio existe para quem abrir o código-fonte
              de um site e precisar saber qual dashboard aquele script alimenta.
              Fica no comentário, e não dentro da chave, porque nome dentro de
              credencial envelhece — foi o que aconteceu com as chaves antigas,
              que ainda dizem o apelido que a loja tinha quando nasceram.
            */}
            <Copiavel multilinha valor={montarSnippet(site, base)} />

            <ProdutoDaPagina site={site} tenantId={loja.id} />
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
              const expandido = expandida === p.id;
              const daMeta = p.id === "meta";

              return (
                <div key={p.id} style={{
                  background: "var(--painel)", border: "1px solid var(--linha)", borderRadius: 8,
                }}>
                  {/* O cabeçalho inteiro é o botão: alvo grande, sem caça ao ícone. */}
                  <button
                    onClick={() => { setExpandida(expandido ? null : p.id); setEditando(null); }}
                    style={{
                      display: "flex", alignItems: "center", gap: 12, width: "100%",
                      padding: "14px 18px", background: "none", border: "none", textAlign: "left",
                    }}>
                    <LogoPlataforma id={p.id} tamanho={28} />

                    <div style={{ flexGrow: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{p.nome}</div>
                      <div className="num" style={{ fontSize: 11, color: "var(--ink-tenue)", marginTop: 2 }}>
                        {daMeta && perfilMeta
                          ? perfilMeta.nome
                          : conta ? `conta ${conta.externalId}` : "não conectada"}
                      </div>
                    </div>

                    {(conta || (daMeta && perfilMeta)) && <Selo ok>conectada</Selo>}

                    <svg width="16" height="16" viewBox="0 0 20 20" fill="none"
                      stroke="var(--ink-tenue)" strokeWidth="1.8" style={{
                        transform: expandido ? "rotate(90deg)" : "none", transition: "transform .15s",
                      }}>
                      <path d="M7 4l6 6-6 6" />
                    </svg>
                  </button>

                  {expandido && daMeta && (
                    <div style={{ padding: "0 18px 18px", borderTop: "1px solid var(--linha)", paddingTop: 16 }}>
                      <PerfisDaMeta tenantId={loja.id} perfil={perfilMeta} />
                    </div>
                  )}

                  {expandido && !daMeta && (
                    <div style={{ padding: "0 18px 18px", borderTop: "1px solid var(--linha)", paddingTop: 16 }}>
                      <div style={{ fontSize: 11.5, color: "var(--ink-tenue)", marginBottom: 12 }}>
                        Conecte sua conta por aqui:
                      </div>

                      {!aberto && (
                        <Botao pequeno tipo="secundario"
                          onClick={() => { setEditando(`conta:${p.id}`); setForm({}); }}>
                          {conta ? "editar credenciais" : "Adicionar conta"}
                        </Botao>
                      )}

                      {aberto && (
                        <>
                          <Campo rotulo="ID da conta de anúncio"
                            placeholder={p.id === "google" ? "123-456-7890" : "1234567890"}
                            dica="É o identificador da conta no gerenciador, não o do pixel." {...campo("externalId")} />

                          {(CREDENCIAIS[p.id] ?? []).map((c) => (
                            <Campo key={c.chave} rotulo={c.rotulo + (c.opcional ? " (opcional)" : "")}
                              type={c.segredo ? "password" : "text"}
                              placeholder="cole aqui" dica={c.dica} {...campo(c.chave)} />
                          ))}

                          <Campo rotulo="Apelido (opcional)" placeholder="Conta principal" {...campo("label")} />

                          {/*
                            Nenhuma plataforma avisa que o token venceu. O sintoma
                            é mudo — a sincronização simplesmente para, e o painel
                            mostra gasto zero como se a campanha tivesse parado.
                            Quem sabe a data é quem gerou o token.
                          */}
                          <Campo rotulo="Vence em (opcional)" type="date"
                            dica="Avisamos com 15 dias de antecedência, na tela de Saúde."
                            {...campo("expiraEm")} />

                          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                            <Botao disabled={salvando} onClick={() => salvar({
                              tipo: "conta_anuncio", plataforma: p.id,
                              externalId: form.externalId, label: form.label,
                              expiraEm: form.expiraEm,
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
                        </>
                      )}
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

            {/*
              Dois cartoes, com os nomes que o lojista ja usa na Utmify.
              
              Um cartao so, chamado "Origem das vendas", era mais preciso e
              pior: obrigava a traduzir o vocabulario dele para o nosso toda
              vez. E a entrada por API ficava escondida como opcao de um menu
              suspenso, que foi exatamente o que tinha acontecido com a
              Shopify — consertar o rotulo de um e deixar o outro enterrado
              era consertar metade do problema.
            */}
            <Cartao titulo="Webhooks"
              descricao="Adicione webhooks para se conectar com as plataformas de venda:">
              {/*
                Agrupado por espécie, e não numa lista só.
                
                O cartão se chamava "Gateways de pagamento" e a Shopify caía
                dentro dele. Quem foi ligar a loja não achou onde — e estava
                certo: a Shopify não é um gateway, e a tela afirmava que era.
                O menu tinha a opção o tempo todo; o rótulo é que escondia.
              */}
              {listaDeConexoes(["plataforma", "gateway"])}

              {editando === "gateway:novo" ? (
                <div style={{ borderTop: "1px solid var(--linha)", paddingTop: 14, marginTop: 4 }}>
                  <label style={{ display: "block", marginBottom: 13 }}>
                    <span style={{
                      display: "block", fontSize: 10.5, letterSpacing: ".07em",
                      textTransform: "uppercase", color: "var(--ink-tenue)",
                      fontWeight: 600, marginBottom: 5,
                    }}>De onde vem a venda</span>
                    {/*
                      Separado por espécie também aqui: no menu corrido, a
                      Shopify aparecia entre gateways de pagamento e ninguém
                      reconhecia aquilo como o lugar de ligar a loja.
                    */}
                    <select value={form.gateway ?? ""} onChange={(e) => setForm((f) => ({ ...f, gateway: e.target.value }))}>
                      <option value="">escolha…</option>
                      {([
                        ["plataforma", "Plataformas de venda"],
                        ["gateway", "Gateways de pagamento"],
                      ] as const).map(([esp, titulo]) => {
                        /*
                         * Sem filtrar o que ja esta ligado: duas lojas Shopify
                         * ou dois gateways da mesma marca sao caso normal, e
                         * esconder a opcao dizia que nao dava — sem dizer por
                         * que, o que e a pior forma de negar.
                         */
                        const desta = gatewaysDisponiveis.filter((g) => g.especie === esp);
                        if (!desta.length) return null;
                        return (
                          <optgroup key={esp} label={titulo}>
                            {desta.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
                          </optgroup>
                        );
                      })}
                    </select>
                  </label>

                  {/*
                    Nome e campos vêm depois da escolha, porque só aí se sabe o
                    que pedir. Cada integração declara o que precisa no próprio
                    adaptador — a tela não tem uma cadeia de `if` por marca.
                  */}
                  {form.gateway && (() => {
                    const esc = gatewaysDisponiveis.find((g) => g.id === form.gateway);
                    if (!esc) return null;
                    return (
                      <>
                        {/*
                          O nome existe porque pode haver duas da mesma marca.
                          Duas linhas escritas "Shopify" nao dizem qual e a loja
                          de fora, e na hora de remover uma vira adivinhacao.
                        */}
                        <Campo rotulo="Nome"
                          dica="Para diferenciar, se um dia houver mais de uma desta mesma plataforma."
                          {...campo("label")} />
                        {esc.credenciais.map((cr) => (
                          <Campo key={cr.chave} rotulo={cr.rotulo} type="password"
                            dica={cr.dica} {...campo(cr.chave)} />
                        ))}
                      </>
                    );
                  })()}
                  <div style={{ display: "flex", gap: 8 }}>
                    {(() => {
                      const esc = gatewaysDisponiveis.find((g) => g.id === form.gateway);
                      /* Campo obrigatorio vazio bloqueia aqui, e nao no servidor:
                         a integracao entraria e falharia calada depois. */
                      const falta = (esc?.credenciais ?? [])
                        .some((cr) => cr.obrigatoria && !form[cr.chave]?.trim());
                      return (
                        <Botao disabled={salvando || !form.gateway || falta} onClick={() => salvar({
                          tipo: "gateway", gateway: form.gateway,
                          label: form.label?.trim() || undefined,
                          ...Object.fromEntries(
                            (esc?.credenciais ?? []).map((cr) => [cr.chave, form[cr.chave]]),
                          ),
                        })}>{salvando ? "salvando…" : "Adicionar"}</Botao>
                      );
                    })()}
                    <Botao tipo="secundario" onClick={() => setEditando(null)}>Cancelar</Botao>
                  </div>
                </div>
              ) : (
                <Botao onClick={() => { setEditando("gateway:novo"); setForm({}); }}>Adicionar Webhook</Botao>
              )}
            </Cartao>

            <Cartao titulo="Credenciais de API"
              descricao="Adicione credenciais de API para integrar com outras ferramentas:">
              {listaDeConexoes(["api"])}

              {/*
                Sem menu de escolha: existe um adaptador de entrada por API, e
                so um. Um <select> de uma opcao so e um passo a mais para
                chegar no mesmo lugar.
              */}
              {(() => {
                const adaptador = gatewaysDisponiveis.find((g) => g.especie === "api");
                if (!adaptador) return null;

                if (editando !== "api:novo") {
                  return (
                    <Botao onClick={() => { setEditando("api:novo"); setForm({}); }}>
                      Adicionar Credencial
                    </Botao>
                  );
                }

                return (
                  <div style={{ borderTop: "1px solid var(--linha)", paddingTop: 14, marginTop: 4 }}>
                    {/*
                      O nome e obrigatorio, e nao opcional com um padrao.
                      
                      Uma credencial sem nome so incomoda quando ja existem
                      tres e nenhuma diz de quem e — que e tarde, porque a
                      essa altura ninguem lembra qual entregou pra quem, e
                      revogar vira adivinhacao.
                    */}
                    <div style={{
                      fontSize: 12.5, fontWeight: 600, marginBottom: 12,
                    }}>Criar Credencial de API</div>
                    <Campo rotulo="Nome"
                      dica="Para saber de quem é esta credencial — o ERP, o checkout próprio, um parceiro."
                      {...campo("label")} />
                    <div style={{ display: "flex", gap: 8 }}>
                      <Botao disabled={salvando || !form.label?.trim()} onClick={() => salvar({
                        tipo: "gateway", gateway: adaptador.id, label: form.label?.trim(),
                      })}>{salvando ? "criando…" : "Criar Credencial"}</Botao>
                      <Botao tipo="secundario" onClick={() => setEditando(null)}>Cancelar</Botao>
                    </div>
                  </div>
                );
              })()}
            </Cartao>

            <Cartao titulo="Seu site"
              descricao="O endereço onde o script vai rodar, e a chave que ele carrega.">
              {editando === "site" ? (
                <>
                  <Campo
                    rotulo="Endereço do site"
                    placeholder="sualoja.com.br"
                    dica="Pode colar com https:// e www — eu limpo."
                    value={form.dominio ?? site?.dominio ?? ""}
                    onChange={(e) => setForm((f) => ({ ...f, dominio: e.target.value }))}
                  />
                  {/*
                    A chave não muda junto com o domínio, de propósito: ela é o
                    que o snippet carrega, e trocá-la faria o script parar em
                    toda página já publicada, sem erro visível.
                  */}
                  {site && (
                    <div style={{ fontSize: 11, color: "var(--ink-tenue)", marginBottom: 13, lineHeight: 1.5 }}>
                      A chave do site continua a mesma. O script já publicado segue funcionando.
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8 }}>
                    <Botao onClick={() => salvar({ tipo: "site", dominio: form.dominio })}
                      disabled={salvando || !(form.dominio ?? "").trim()} pequeno>
                      {salvando ? "salvando…" : "Salvar"}
                    </Botao>
                    <Botao tipo="secundario" pequeno
                      onClick={() => { setEditando(null); setForm({}); }}>Cancelar</Botao>
                  </div>
                </>
              ) : site ? (
                <>
                  <div style={{ marginBottom: 14 }}>
                    <div style={{
                      fontSize: 10.5, letterSpacing: ".07em", textTransform: "uppercase",
                      color: "var(--ink-tenue)", fontWeight: 600, marginBottom: 5,
                    }}>Domínio</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <span className="num" style={{ fontSize: 12.5, flexGrow: 1 }}>{site.dominio}</span>
                      <Botao tipo="secundario" pequeno
                        onClick={() => { setEditando("site"); setForm({ dominio: site.dominio }); }}>
                        trocar
                      </Botao>
                    </div>
                  </div>
                  <Copiavel rotulo="Chave do site" valor={site.chave} />
                  <div style={{
                    fontSize: 11, color: "var(--ink-tenue)", marginTop: 12, lineHeight: 1.5,
                  }}>
                    O script para colar está no topo desta tela. Esta chave é o que ele
                    carrega — quem tiver ela pode mandar evento para esta loja, então
                    trate como segredo de configuração, não como identificador público.
                  </div>
                  {/*
                    Regerar só faz sentido antes de o script ir para o ar, ou
                    quando a chave vazou. Depois de publicado, trocar derruba a
                    coleta sem erro nenhum aparecer — daí o aviso e a confirmação.
                  */}
                  {editando === "regerar" ? (
                    <div style={{
                      marginTop: 12, padding: "11px 13px", borderRadius: 6,
                      background: "var(--alerta-fundo)", border: "1px solid var(--alerta)",
                    }}>
                      <div style={{ fontSize: 12, color: "var(--ink-medio)", lineHeight: 1.5, marginBottom: 10 }}>
                        A chave nova só vale para o script atualizado. Se o antigo já
                        estiver em alguma página, ela para de coletar ali — sem erro,
                        só sem eventos.
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <Botao pequeno disabled={salvando}
                          onClick={() => salvar({ tipo: "regerar_chave" })}>
                          {salvando ? "gerando…" : "Gerar chave nova"}
                        </Botao>
                        <Botao tipo="secundario" pequeno onClick={() => setEditando(null)}>
                          Cancelar
                        </Botao>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => setEditando("regerar")} style={{
                      marginTop: 10, background: "none", border: "none", padding: 0,
                      cursor: "pointer", color: "var(--ink-tenue)", fontSize: 11,
                    }}>gerar uma chave nova</button>
                  )}
                </>
              ) : (
                <>
                  <div style={{ fontSize: 12, color: "var(--ink-tenue)", marginBottom: 12, lineHeight: 1.5 }}>
                    Nenhum site cadastrado. Sem ele o script não tem chave para carregar,
                    e nenhum clique é coletado.
                  </div>
                  <Botao pequeno onClick={() => { setEditando("site"); setForm({}); }}>
                    Cadastrar site
                  </Botao>
                </>
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

/* --------------------------------------------------- produto da página -- */

type ConfigDoSite = {
  viewContentOnLoad?: boolean;
  productId?: string;
  productName?: string;
  productPriceCents?: number;
};

/*
 * O snippet, já com o que a loja configurou.
 *
 * Montar o texto aqui em vez de mandar o lojista editar à mão não é conforto:
 * é a diferença entre uma opção que existe e uma opção que é usada. Ninguém
 * abre o código-fonte do próprio site para acrescentar uma vírgula num objeto
 * de configuração — e enquanto não acrescentasse, a etapa "viu o produto"
 * ficaria zerada parecendo campanha ruim.
 */
export function montarSnippet(
  site: { dominio: string; chave: string; config: ConfigDoSite },
  base: string,
): string {
  const cfg = [`siteKey:"${site.chave}"`, `endpoint:"${base}/rr/collect"`];

  if (site.config.viewContentOnLoad) cfg.push("viewContentOnLoad:true");

  if (site.config.productId) {
    const p = [`id:${JSON.stringify(site.config.productId)}`];
    if (site.config.productName) p.push(`name:${JSON.stringify(site.config.productName)}`);
    /* O rr.js fala em reais, como o resto do mundo de pixel; o banco guarda
       centavo. A conversão acontece aqui, num lugar só. */
    if (site.config.productPriceCents) {
      p.push(`price:${(site.config.productPriceCents / 100).toFixed(2)}`);
    }
    cfg.push(`product:{${p.join(",")}}`);
  }

  return `<!-- RRTrack · ${site.dominio} -->\n`
    + `<script>window.RRTrackConfig={${cfg.join(",")}}</script>\n`
    + `<script src="${base}/rr.js" async></script>`;
}

/*
 * Diz ao script o que a página é.
 *
 * Duas perguntas só, e as duas nasceram de números errados no painel.
 *
 * A primeira — "a página de entrada já é a do produto" — conserta um funil com
 * etapa permanentemente zerada. O rr.js espera um `data-rr-view` no HTML para
 * disparar "viu o produto"; numa oferta de página única esse atributo nunca
 * existe, porque não há uma página de produto separada para marcar.
 *
 * A segunda — o produto e o preço — conserta evento sem valor. Hoje o
 * `begin_checkout` chega à Meta com o corpo vazio, e ela só consegue otimizar
 * por quantidade de clique. Com preço, passa a otimizar por retorno, que é o
 * que se quer de campanha de venda.
 */
export function ProdutoDaPagina({ site, tenantId }: {
  site: { dominio: string; chave: string; config: ConfigDoSite };
  tenantId: string;
}) {
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const [paginaDeProduto, setPaginaDeProduto] = useState(!!site.config.viewContentOnLoad);
  const [id, setId] = useState(site.config.productId ?? "");
  const [nome, setNome] = useState(site.config.productName ?? "");
  const [preco, setPreco] = useState(
    site.config.productPriceCents
      ? (site.config.productPriceCents / 100).toFixed(2).replace(".", ",")
      : "",
  );

  const configurado = !!site.config.viewContentOnLoad || !!site.config.productId;

  async function salvar() {
    setErro(null);
    setSalvando(true);
    try {
      const r = await fetch("/api/integracoes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantId,
          tipo: "produto",
          paginaDeProduto,
          id: id.trim() || undefined,
          nome: nome.trim() || undefined,
          preco: preco.trim()
            ? parseFloat(preco.replace(/\./g, "").replace(",", "."))
            : undefined,
        }),
      });
      const j = await r.json() as { erro?: string };
      if (!r.ok) { setErro(j.erro ?? "falha ao gravar"); setSalvando(false); return; }
      setAberto(false);
      router.refresh();
    } catch {
      setErro("sem conexão com o servidor");
    }
    setSalvando(false);
  }

  return (
    <div style={{ marginTop: 12, borderTop: "1px solid var(--linha)", paddingTop: 12 }}>
      <button
        onClick={() => setAberto((v) => !v)}
        style={{
          background: "none", border: "none", padding: 0, display: "flex",
          alignItems: "center", gap: 7, fontSize: 12, color: "var(--ink-fraco)",
        }}
      >
        <svg width="12" height="12" viewBox="0 0 20 20" fill="none"
          stroke="currentColor" strokeWidth="2"
          style={{ transform: aberto ? "rotate(90deg)" : "none", transition: "transform .15s" }}>
          <path d="M7 4l6 6-6 6" />
        </svg>
        Produto da página
        {/*
          Deixou de ser alerta: o script lê o produto da própria página quando
          ela publica um (Shopify, JSON-LD, Open Graph). Loja com catálogo não
          tem o que preencher aqui — e o "não configurado" em vermelho mandava
          preencher uma coisa por página, que ninguém faz.
        */}
        <span style={{ color: configurado ? "var(--positivo)" : "var(--ink-tenue)" }}>
          {configurado ? "fixo neste script" : "lido da página"}
        </span>
      </button>

      {!aberto && !configurado && (
        <div style={{
          fontSize: 11.5, color: "var(--ink-tenue)", marginTop: 7, lineHeight: 1.55,
        }}>
          O script lê o produto da própria página — serve para loja com catálogo,
          onde cada página tem um. Preencha aqui só numa oferta de página única,
          se a página não publicar o produto sozinha.
        </div>
      )}

      {aberto && (
        <div style={{ marginTop: 13, maxWidth: 520 }}>
          <label style={{
            display: "flex", alignItems: "flex-start", gap: 8,
            fontSize: 12.5, color: "var(--ink-medio)", marginBottom: 14, lineHeight: 1.5,
          }}>
            <input
              type="checkbox"
              checked={paginaDeProduto}
              onChange={(e) => setPaginaDeProduto(e.target.checked)}
              style={{ width: "auto", marginTop: 2 }}
            />
            <span>
              A página que o visitante abre <b>já é</b> a página do produto.
              <span style={{ display: "block", fontSize: 11, color: "var(--ink-tenue)", marginTop: 3 }}>
                Marque em oferta de página única, onde &quot;viu o produto&quot; e
                &quot;visitou o site&quot; são a mesma coisa. Em loja com catálogo
                deixe desmarcado: o ViewContent dispara sozinho nas páginas que
                publicam um produto, e não na home nem nas coleções.
              </span>
            </span>
          </label>

          {/*
            Os três campos abaixo são para oferta de página única. Numa loja com
            catálogo ficam vazios, e o script lê cada página.
          */}
          <div style={{
            fontSize: 11.5, color: "var(--ink-tenue)", marginBottom: 12, lineHeight: 1.55,
          }}>
            Só preencha em oferta de <b>uma página só</b>. Numa loja com catálogo,
            deixe vazio — o script lê o produto de cada página pela Shopify, por
            JSON-LD ou por Open Graph, e usa o mesmo identificador que o pedido vai
            usar depois, para a Meta casar quem viu com quem comprou.
          </div>

          <Campo rotulo="Identificador do produto" placeholder="carimbo-delineador"
            value={id} onChange={(e) => setId(e.target.value)}
            dica="Qualquer código estável. É o que agrupa o produto nos relatórios das plataformas." />

          <Campo rotulo="Nome" placeholder="Carimbo de Delineador Gatinho Perfeito"
            value={nome} onChange={(e) => setNome(e.target.value)} />

          <Campo rotulo="Preço (R$)" placeholder="89,90"
            value={preco} onChange={(e) => setPreco(e.target.value)}
            dica="Vai junto em cada evento. É o que deixa a Meta otimizar por retorno, e não só por volume de clique." />

          {erro && (
            <div style={{
              background: "var(--negativo-fundo)", border: "1px solid var(--negativo)",
              borderRadius: 5, padding: "8px 11px", fontSize: 12,
              color: "var(--negativo)", marginBottom: 11,
            }}>{erro}</div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <Botao pequeno onClick={salvar} disabled={salvando}>
              {salvando ? "salvando..." : "Salvar"}
            </Botao>
            <Botao pequeno tipo="secundario" onClick={() => { setAberto(false); setErro(null); }}>
              cancelar
            </Botao>
          </div>

          <div style={{
            fontSize: 11, color: "var(--ink-tenue)", marginTop: 12, lineHeight: 1.55,
          }}>
            Depois de salvar, copie o script de novo — ele sai com estes valores dentro.
            <br />
            O <b>adicionar ao carrinho</b> não precisa de configuração: o script já
            reconhece botões com <span className="num">data-add-to-cart</span>.
          </div>
        </div>
      )}
    </div>
  );
}
