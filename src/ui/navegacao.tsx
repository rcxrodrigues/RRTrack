"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import type { LojaDoUsuario } from "@/core/auth";
import { SeletorLoja } from "./seletor-loja";

/*
 * Barra lateral e topo do painel.
 *
 * A navegação tem uma seção por fonte de tráfego — Meta, Google, TikTok — e
 * não uma tela única de "campanhas". Não é preferência estética:
 * as plataformas têm estruturas diferentes de verdade. O Google tem grupo de
 * anúncios e palavra-chave, a Meta tem conjunto e posicionamento, o TikTok
 * chama conjunto de AID. Espremer as três numa tabela só obriga a inventar
 * colunas vazias para duas delas.
 */

const ico = (d: string) => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" width="17" height="17">
    <g dangerouslySetInnerHTML={{ __html: d }} />
  </svg>
);

const D = {
  resumo: '<rect x="3" y="3" width="6.5" height="6.5" rx="1.5"/><rect x="10.5" y="3" width="6.5" height="6.5" rx="1.5"/><rect x="3" y="10.5" width="6.5" height="6.5" rx="1.5"/><rect x="10.5" y="10.5" width="6.5" height="6.5" rx="1.5"/>',
  meta: '<path d="M2.5 12.5c0-4 1.8-6.5 4-6.5 1.6 0 2.6 1 3.5 2.6.9-1.6 1.9-2.6 3.5-2.6 2.2 0 4 2.5 4 6.5 0 1.7-.9 2.5-2 2.5-1.6 0-2.6-1.6-3.6-3.4L10 9.4l-1.9 2.2C7.1 13.4 6.1 15 4.5 15c-1.1 0-2-.8-2-2.5z"/>',
  google: '<path d="M17 10.2c0-.6-.05-1.1-.15-1.7H10v3.2h3.9a3.4 3.4 0 0 1-1.45 2.2v1.9h2.35c1.37-1.3 2.2-3.2 2.2-5.6z"/><path d="M10 17.5c1.95 0 3.6-.65 4.8-1.75l-2.35-1.9c-.65.45-1.5.7-2.45.7-1.9 0-3.5-1.25-4.08-2.95H3.5v1.95A7.5 7.5 0 0 0 10 17.5z"/><path d="M5.92 11.6a4.5 4.5 0 0 1 0-2.85V6.8H3.5a7.5 7.5 0 0 0 0 6.75l2.42-1.95z"/><path d="M10 5.55c1.07 0 2.03.37 2.79 1.09l2.08-2.08A7.4 7.4 0 0 0 10 2.5 7.5 7.5 0 0 0 3.5 6.8l2.42 1.95C6.5 6.8 8.1 5.55 10 5.55z"/>',
  tiktok: '<path d="M12.5 3v8.2a3 3 0 1 1-2.4-2.94"/><path d="M12.5 3c.4 1.9 1.7 3.1 3.7 3.3"/>',
  utms: '<path d="M8.5 11.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.54 3.54 0 0 0-5-5l-1.4 1.4"/><path d="M11.5 8.5a3.5 3.5 0 0 0-5 0L4 11a3.54 3.54 0 0 0 5 5l1.4-1.4"/>',
  rastreio: '<circle cx="10" cy="10" r="2"/><path d="M5.8 5.8a6 6 0 0 0 0 8.4M14.2 5.8a6 6 0 0 1 0 8.4"/>',
  integra: '<path d="M7 3v5M13 3v5M4.5 8h11v3a5.5 5.5 0 0 1-11 0V8zM10 16.5V18"/>',
  produtos: '<path d="M10 2.5l7 3.7v7.6l-7 3.7-7-3.7V6.2l7-3.7zM3 6.2l7 3.7 7-3.7M10 9.9V17"/>',
  testes: '<path d="M8 2.5v5.2L4 15a1.6 1.6 0 0 0 1.4 2.5h9.2A1.6 1.6 0 0 0 16 15l-4-7.3V2.5M7 2.5h6M6.2 12h7.6"/>',
};

const SECOES: Array<{ grupo?: string; itens: Array<{ href: string; rotulo: string; icone: string }> }> = [
  { itens: [{ href: "/", rotulo: "Resumo", icone: D.resumo }] },
  {
    grupo: "Tráfego",
    itens: [
      { href: "/meta", rotulo: "Meta", icone: D.meta },
      { href: "/google", rotulo: "Google", icone: D.google },
      { href: "/tiktok", rotulo: "TikTok", icone: D.tiktok },
    ],
  },
  {
    grupo: "Rastreamento",
    itens: [
      { href: "/utms", rotulo: "UTMs", icone: D.utms },
      { href: "/rastreamento", rotulo: "Saúde", icone: D.rastreio },
      { href: "/testes", rotulo: "Testes", icone: D.testes },
    ],
  },
  {
    grupo: "Configuração",
    itens: [
      { href: "/produtos", rotulo: "Produtos", icone: D.produtos },
      { href: "/integracoes", rotulo: "Integrações", icone: D.integra },
    ],
  },
];

export function Navegacao({
  lojaAtual, lojas, usuario,
}: {
  lojaAtual: LojaDoUsuario | null;
  lojas: LojaDoUsuario[];
  usuario: { nome: string | null; email: string };
}) {
  const caminho = usePathname();
  const router = useRouter();

  /*
   * Recolhido vira faixa de ícones, e não some de vez: com onze destinos, o
   * menu escondido custaria um clique a mais em toda navegação, e o que se
   * queria era espaço, não menos caminho.
   *
   * Começa aberto e aplica a escolha depois de montar. O servidor não conhece
   * o localStorage, e renderizar recolhido de um lado e aberto do outro faria
   * o React descartar a árvore inteira.
   */
  const [recolhido, setRecolhido] = useState(false);

  useEffect(() => {
    try { setRecolhido(localStorage.getItem("rr_menu") === "recolhido"); } catch { /* modo privado */ }
  }, []);

  /*
   * O menu do usuário: avatar no topo, e-mail e sair dentro.
   *
   * Ele existe no TOPO, e não no pé, por um motivo que só aparecia no
   * celular: abaixo de 860px a barra lateral vira faixa horizontal, e o CSS
   * escondia o rodapé — que era exatamente onde o "sair" morava. No telefone
   * não havia como sair da conta, e nada na tela dizia isso.
   */
  const [menuAberto, setMenuAberto] = useState(false);
  const caixaUsuario = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuAberto) return;

    function foraDaCaixa(ev: MouseEvent) {
      if (!caixaUsuario.current?.contains(ev.target as Node)) setMenuAberto(false);
    }
    function tecla(ev: KeyboardEvent) {
      if (ev.key === "Escape") setMenuAberto(false);
    }

    /*
     * `mousedown` e não `click`: com `click`, o mesmo toque que abre o menu
     * fecharia na sequência, porque o evento sobe até o documento depois.
     */
    document.addEventListener("mousedown", foraDaCaixa);
    document.addEventListener("keydown", tecla);
    return () => {
      document.removeEventListener("mousedown", foraDaCaixa);
      document.removeEventListener("keydown", tecla);
    };
  }, [menuAberto]);

  function alternar() {
    setRecolhido((v) => {
      const novo = !v;
      try { localStorage.setItem("rr_menu", novo ? "recolhido" : "aberto"); } catch { /* idem */ }
      return novo;
    });
  }

  const iniciais = (usuario.nome ?? usuario.email)
    .split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");

  async function sair() {
    await fetch("/api/auth/sair", { method: "POST" });
    router.refresh();
    router.push("/entrar");
  }

  /*
   * O widget de conta: avatar redondo com as iniciais, e um menu com o e-mail
   * e o sair.
   *
   * Fica aqui dentro, e não em componente separado, porque depende de cinco
   * coisas do estado desta função — iniciais, usuário, `sair`, `menuAberto` e
   * a referência da caixa. Extrair custaria cinco propriedades para ganhar
   * nada.
   *
   * E é CHAMADA — `{menuUsuario()}` — em vez de usada como elemento. Como a
   * declaração está dentro de outra, cada render de `Navegacao` produz um tipo
   * de componente novo, e tipo novo o React não reaproveita: desmonta o DOM e
   * monta outro. O `ref` se solta e o foco do botão some a cada abertura.
   * Chamada, o JSX entra direto no lugar e nada disso acontece.
   *
   * O e-mail aparece no menu porque com várias contas (a do Ryan e a de um
   * sócio) o avatar de iniciais sozinho não diz em qual você está — e sair da
   * conta errada é o tipo de erro que só se percebe depois de entrar de novo.
   */
  function menuUsuario() {
    return (
      <div ref={caixaUsuario} style={{ position: "relative", flexShrink: 0 }}>
        <button
          onClick={() => setMenuAberto((v) => !v)}
          title={usuario.nome ?? usuario.email}
          aria-label="Conta"
          aria-expanded={menuAberto}
          className="num"
          style={{
            width: 26, height: 26, borderRadius: "50%", border: "none",
            padding: 0, cursor: "pointer",
            background: "var(--acento-fundo)", color: "var(--acento)",
            display: "grid", placeItems: "center",
            fontWeight: 600, fontSize: 10,
          }}
        >{iniciais}</button>

        {menuAberto && (
          <div style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0,
            minWidth: 190, zIndex: 50,
            background: "var(--painel-alto)", border: "1px solid var(--linha-forte)",
            borderRadius: 8, padding: 4,
            boxShadow: "0 10px 28px rgba(0,0,0,.45)",
          }}>
            <div style={{ padding: "8px 10px 9px", borderBottom: "1px solid var(--linha)" }}>
              {usuario.nome && (
                <div style={{
                  fontSize: 12, fontWeight: 600, overflow: "hidden",
                  textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>{usuario.nome}</div>
              )}
              {/*
                O e-mail pode ser longo e não pode ser cortado sem aviso: é o
                que identifica a conta. `break-all` deixa quebrar em duas
                linhas em vez de virar "ryan.rodrig…".
              */}
              <div style={{
                fontSize: 11, color: "var(--ink-tenue)", wordBreak: "break-all",
                marginTop: usuario.nome ? 2 : 0,
              }}>{usuario.email}</div>
            </div>

            <button onClick={sair} style={{
              display: "flex", alignItems: "center", gap: 8, width: "100%",
              background: "none", border: "none", cursor: "pointer",
              padding: "8px 10px", borderRadius: 5,
              fontSize: 12, color: "var(--ink-medio)", textAlign: "left",
            }}>
              <svg width="13" height="13" viewBox="0 0 20 20" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M8 17H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3" />
                <path d="M13 14l4-4-4-4M17 10H8" />
              </svg>
              Sair
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <aside className="rr-lateral" style={{
      width: recolhido ? 52 : 178,
      transition: "width .16s ease",
      flexShrink: 0, borderRight: "1px solid var(--linha)",
      background: "var(--painel)", display: "flex", flexDirection: "column",
      height: "100vh", position: "sticky", top: 0,
    }}>

      {/*
        A marca troca com o estado do menu: recolhido mostra só o símbolo,
        expandido mostra a marca inteira. Não é enfeite — em 52px de largura a
        palavra "RRTrack" não caberia, e cortá-la fica pior que escondê-la.

        Os dois arquivos são PNG e não SVG porque a logo nasceu de imagem, não
        de vetor. Foram gerados a três vezes o tamanho de exibição, que é o que
        os mantém nítidos em tela retina — e ainda assim somam 26 KB.
      */}
      <div className="rr-lateral-topo" style={{
        padding: "16px 14px 12px", display: "flex", alignItems: "center",
        gap: 9, justifyContent: "space-between",
      }}>
        {recolhido ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src="/marca/icone.png" alt="RRTrack" width={24} height={24}
            style={{ display: "block", margin: "0 auto" }} />
        ) : (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/marca/completa.png" alt="RRTrack" height={22}
              style={{ display: "block", width: "auto" }} />
            {menuUsuario()}
          </>
        )}
      </div>

      {/* Em 52px de largura o avatar não cabe ao lado do símbolo: desce. */}
      {recolhido && (
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
          {menuUsuario()}
        </div>
      )}

      {/*
        Seletor de dashboard. Cada um isola gateways, pixels e contas de
        anúncio — é o que impede duas ofertas de disparar conversão para o
        pixel uma da outra.
      */}
      {/* O seletor precisa do nome da loja para servir de alguma coisa; em
          52px sobraria só a sacola, que não diz qual dashboard está aberto. */}
      {/*
        Lista vazia = o ENDEREÇO já decidiu a loja (track.<oferta>). Aí não há o
        que trocar, e um seletor ali só serviria para alguém abrir a oferta
        errada sem querer. O nome fica, parado: você precisa saber em qual
        painel está, mesmo sem poder sair dele por aqui.
      */}
      {!recolhido && (lojas.length > 0
        ? <SeletorLoja atual={lojaAtual} lojas={lojas} />
        : (
          <div style={{ padding: "0 14px 14px" }}>
            <div style={{
              width: "100%", display: "flex", alignItems: "center", gap: 7,
              padding: "6px 8px", borderRadius: 5,
              border: "1px solid transparent", color: "var(--ink-fraco)",
            }}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                   strokeWidth="1.5" style={{ flexShrink: 0 }}>
                <path d="M2.5 6h11l-1 7.5h-9L2.5 6zM5.5 6V4a2.5 2.5 0 0 1 5 0v2" />
              </svg>
              <span style={{
                flexGrow: 1, fontSize: 11.5, fontWeight: 500,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>{lojaAtual?.nome ?? "sem dashboard"}</span>
            </div>
          </div>
        ))}

      {/* navegação */}
      <nav style={{ flexGrow: 1, overflowY: "auto", padding: "0 10px" }}>
        {SECOES.map((secao, i) => (
          <div key={i} style={{ marginBottom: 14 }}>
            {secao.grupo && !recolhido && (
              <div className="rr-grupo" style={{
                fontSize: 9.5, letterSpacing: ".1em", textTransform: "uppercase",
                color: "var(--ink-tenue)", fontWeight: 600, padding: "6px 10px 6px",
              }}>{secao.grupo}</div>
            )}
            {secao.itens.map((item) => {
              const ativo = caminho === item.href;
              return (
                <Link key={item.href} href={item.href}
                  /* Recolhido, o rótulo vira dica do sistema — senão os ícones
                     viram adivinhação para quem não abre o painel todo dia. */
                  title={recolhido ? item.rotulo : undefined}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    justifyContent: recolhido ? "center" : "flex-start",
                    padding: recolhido ? "8px 0" : "7px 10px",
                    borderRadius: 6, marginBottom: 1,
                    background: ativo ? "var(--acento-fundo)" : "transparent",
                    color: ativo ? "var(--acento)" : "var(--ink-fraco)",
                    fontSize: 12.5, fontWeight: ativo ? 600 : 500,
                  }}>
                  {ico(item.icone)}
                  {!recolhido && <span>{item.rotulo}</span>}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/*
        O botão de recolher mora no pé, e não junto do logo, porque lá em cima
        não cabe: em 178px de lateral sobram 150 úteis, e logo (109) + botão
        (24) + avatar (26) com os respiros dão 177. Como o logo tem largura
        mínima automática e não encolhe, quem era empurrado para fora era o
        avatar — ele terminava 13px além da borda, montado na linha divisória.
        Apertar não resolve: mesmo com respiro zero são 159 para 150.

        Aqui embaixo não custa altura nenhuma: é a mesma faixa onde ficava o
        bloco de usuário, que virou o avatar lá em cima.
      */}
      <div style={{
        borderTop: "1px solid var(--linha)", padding: "8px 14px",
        display: "flex", justifyContent: recolhido ? "center" : "flex-end",
      }}>
        <button onClick={alternar}
          title={recolhido ? "Expandir menu" : "Recolher menu"}
          aria-label={recolhido ? "Expandir menu" : "Recolher menu"}
          style={botaoRecolher}>
          <IconeRecolher recolhido={recolhido} />
        </button>
      </div>
    </aside>
  );
}

const botaoRecolher: React.CSSProperties = {
  width: 24, height: 24, flexShrink: 0, display: "grid", placeItems: "center",
  border: "none", background: "transparent", borderRadius: 5, cursor: "pointer",
  color: "var(--ink-tenue)", padding: 0,
};

/*
 * Aberto mostra uma seta para dentro; recolhido, as três barras de menu. O
 * ícone diz o que vai ACONTECER ao clicar, e não o estado atual — é a
 * convenção que as pessoas já leem sem pensar.
 */
function IconeRecolher({ recolhido }: { recolhido: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none"
         stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"
         strokeLinejoin="round">
      {recolhido ? (
        <>
          <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
        </>
      ) : (
        <>
          <path d="M9.5 5 6.5 8l3 3" />
          <path d="M13 3.8v8.4" opacity=".45" />
          <path d="M2.5 8h4" opacity=".45" />
        </>
      )}
    </svg>
  );
}
