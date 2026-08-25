"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import type { LojaDoUsuario } from "@/core/auth";
import { SeletorLoja } from "./seletor-loja";

/*
 * Barra lateral e topo do painel.
 *
 * A navegação tem uma seção por fonte de tráfego — Meta, Google, Kwai, TikTok,
 * Taboola — e não uma tela única de "campanhas". Não é preferência estética:
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
  kwai: '<rect x="3" y="3" width="14" height="14" rx="4"/><path d="M8 7v6l5-3z"/>',
  tiktok: '<path d="M12.5 3v8.2a3 3 0 1 1-2.4-2.94"/><path d="M12.5 3c.4 1.9 1.7 3.1 3.7 3.3"/>',
  taboola: '<ellipse cx="6.5" cy="10" rx="3.5" ry="4"/><ellipse cx="13.5" cy="10" rx="3.5" ry="4"/>',
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
      { href: "/kwai", rotulo: "Kwai", icone: D.kwai },
      { href: "/tiktok", rotulo: "TikTok", icone: D.tiktok },
      { href: "/taboola", rotulo: "Taboola", icone: D.taboola },
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

  const iniciais = (usuario.nome ?? usuario.email)
    .split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");

  async function sair() {
    await fetch("/api/auth/sair", { method: "POST" });
    router.refresh();
    router.push("/entrar");
  }

  return (
    <aside style={{
      width: 178, flexShrink: 0, borderRight: "1px solid var(--linha)",
      background: "var(--painel)", display: "flex", flexDirection: "column",
      height: "100vh", position: "sticky", top: 0,
    }}>

      <div style={{ padding: "16px 14px 12px", display: "flex", alignItems: "center", gap: 9 }}>
        <svg width="20" height="20" viewBox="0 0 18 18" fill="none" stroke="var(--acento)" strokeWidth="1.6">
          <circle cx="9" cy="9" r="1.8" fill="var(--acento)" stroke="none" />
          <path d="M4.2 4.2a6.8 6.8 0 0 0 0 9.6M13.8 4.2a6.8 6.8 0 0 1 0 9.6" />
        </svg>
        <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: "-.2px" }}>RRTrack</span>
      </div>

      {/*
        Seletor de dashboard. Cada um isola gateways, pixels e contas de
        anúncio — é o que impede duas ofertas de disparar conversão para o
        pixel uma da outra.
      */}
      <SeletorLoja atual={lojaAtual} lojas={lojas} />

      {/* navegação */}
      <nav style={{ flexGrow: 1, overflowY: "auto", padding: "0 10px" }}>
        {SECOES.map((secao, i) => (
          <div key={i} style={{ marginBottom: 14 }}>
            {secao.grupo && (
              <div style={{
                fontSize: 9.5, letterSpacing: ".1em", textTransform: "uppercase",
                color: "var(--ink-tenue)", fontWeight: 600, padding: "6px 10px 6px",
              }}>{secao.grupo}</div>
            )}
            {secao.itens.map((item) => {
              const ativo = caminho === item.href;
              return (
                <Link key={item.href} href={item.href} style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "7px 10px", borderRadius: 6, marginBottom: 1,
                  background: ativo ? "var(--acento-fundo)" : "transparent",
                  color: ativo ? "var(--acento)" : "var(--ink-fraco)",
                  fontSize: 12.5, fontWeight: ativo ? 600 : 500,
                }}>
                  {ico(item.icone)}
                  <span>{item.rotulo}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* usuário */}
      <div style={{
        borderTop: "1px solid var(--linha)", padding: "10px",
        display: "flex", alignItems: "center", gap: 9,
      }}>
        <div className="num" style={{
          width: 26, height: 26, borderRadius: 6, flexShrink: 0,
          background: "var(--acento-fundo)", color: "var(--acento)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontWeight: 600, fontSize: 10.5,
        }}>{iniciais}</div>
        <div style={{ flexGrow: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 11.5, fontWeight: 600, overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{usuario.nome ?? usuario.email}</div>
          <button onClick={sair} style={{
            background: "none", border: "none", padding: 0,
            fontSize: 10.5, color: "var(--ink-tenue)",
          }}>sair</button>
        </div>
      </div>
    </aside>
  );
}
