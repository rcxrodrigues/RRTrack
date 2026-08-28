"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { brl } from "./comum";
import { PainelShopify, SeletorDeProduto } from "./shopify";
import type { VarianteEscolhida } from "./shopify";
import type { CheckoutNaLista, OpcoesDoFormulario } from "@/checkout/gestao";

/*
 * Onde o lojista monta o próprio checkout.
 *
 * A tela é uma lista de ofertas, e cada oferta é um endereço público. O que ela
 * pede é deliberadamente pouco: produto, preço, gateway e forma de pagamento.
 * Tudo o mais tem padrão, porque quem está subindo uma campanha às onze da
 * noite não quer configurar catálogo — quer um link para colar no anúncio.
 *
 * O preço é digitado em reais e convertido para centavos aqui, uma vez só. O
 * resto do sistema nunca vê um valor fracionário: centavo inteiro em todo lugar
 * é o que impede R$ 0,01 de sumir num arredondamento entre a tela e a cobrança.
 */

type Item = {
  sku: string; name: string; quantidade: string; preco: string; digital: boolean;
  /* Presente quando o item veio do catalogo da Shopify. E o que faz o pedido
     cair no produto certo la e baixar o estoque certo. */
  shopifyVariantId?: string;
};

interface Rascunho {
  id?: string;
  name: string;
  slug: string;
  gatewayConnectionId: string;
  siteId: string;
  shopifyConnectionId: string;
  itens: Item[];
  frete: string;
  metodos: string[];
  maxInstallments: number;
  cor: string;
  logoUrl: string;
  redirectUrl: string;
  supportEmail: string;
  softDescriptor: string;
  appmaxExternalId: string;
  active: boolean;
}

const ITEM_VAZIO: Item = { sku: "", name: "", quantidade: "1", preco: "", digital: false };

function rascunhoVazio(opcoes: OpcoesDoFormulario): Rascunho {
  return {
    name: "", slug: "",
    gatewayConnectionId: opcoes.conexoes.find((c) => c.gateway === "appmax")?.id ?? "",
    siteId: opcoes.sites[0]?.id ?? "",
    /*
     * Ja nasce ligado quando ha loja conectada.
     *
     * O contrario seria pior: um checkout criado sem a ligacao cobra normal e
     * simplesmente nao cria o pedido na Shopify, sem erro nenhum. Ligado por
     * padrao, o unico jeito de errar e explicito — o formulario recusa salvar
     * com produto que nao veio de la, dizendo o que fazer.
     */
    shopifyConnectionId: opcoes.lojasShopify[0]?.id ?? "",
    itens: [{ ...ITEM_VAZIO }],
    frete: "",
    metodos: ["pix", "credit_card"],
    maxInstallments: 12,
    cor: "", logoUrl: "", redirectUrl: "", supportEmail: "",
    softDescriptor: "", appmaxExternalId: "",
    active: true,
  };
}

const centavos = (reais: string): number => {
  const n = parseFloat(reais.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};

const emReais = (c: number): string => (c / 100).toFixed(2).replace(".", ",");

function paraRascunho(c: CheckoutNaLista): Rascunho {
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    gatewayConnectionId: c.gatewayConnectionId,
    siteId: c.siteId ?? "",
    shopifyConnectionId: c.shopifyConnectionId ?? "",
    itens: c.items.map((i) => ({
      sku: i.sku, name: i.name,
      quantidade: String(i.quantity),
      preco: emReais(i.unitPriceCents),
      digital: i.digital === true,
      shopifyVariantId: i.shopifyVariantId,
    })),
    frete: c.shippingCents ? emReais(c.shippingCents) : "",
    metodos: c.methods,
    maxInstallments: c.maxInstallments,
    cor: c.config.cor ?? "",
    logoUrl: c.config.logoUrl ?? "",
    redirectUrl: c.config.redirectUrl ?? "",
    supportEmail: c.config.supportEmail ?? "",
    softDescriptor: c.config.softDescriptor ?? "",
    appmaxExternalId: c.config.appmaxExternalId ?? "",
    active: c.active,
  };
}

export function Checkouts({ tenantId, checkouts, opcoes, base }: {
  tenantId: string;
  checkouts: CheckoutNaLista[];
  opcoes: OpcoesDoFormulario;
  /* Domínio público, para montar o link que o lojista vai copiar. */
  base: string;
}) {
  const router = useRouter();
  const [rascunho, setRascunho] = useState<Rascunho | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const temAppmax = opcoes.conexoes.some((c) => c.gateway === "appmax");

  async function salvar() {
    if (!rascunho) return;
    setErro(null);
    setSalvando(true);

    const itens = [];
    for (const i of rascunho.itens) {
      if (!i.name.trim() && !i.preco.trim()) continue;
      const preco = centavos(i.preco);
      if (!Number.isFinite(preco)) {
        setErro(`Preço inválido em "${i.name || "produto sem nome"}".`);
        setSalvando(false);
        return;
      }
      itens.push({
        sku: i.sku.trim() || undefined,
        name: i.name.trim(),
        quantity: Number(i.quantidade) || 1,
        unitPriceCents: preco,
        digital: i.digital,
        shopifyVariantId: i.shopifyVariantId,
      });
    }

    const frete = rascunho.frete.trim() ? centavos(rascunho.frete) : 0;
    if (!Number.isFinite(frete)) {
      setErro("Frete inválido.");
      setSalvando(false);
      return;
    }

    try {
      const r = await fetch("/api/checkouts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantId,
          id: rascunho.id,
          name: rascunho.name,
          slug: rascunho.slug || rascunho.name,
          gatewayConnectionId: rascunho.gatewayConnectionId,
          siteId: rascunho.siteId || null,
          shopifyConnectionId: rascunho.shopifyConnectionId || null,
          items: itens,
          shippingCents: frete,
          methods: rascunho.metodos,
          maxInstallments: rascunho.maxInstallments,
          active: rascunho.active,
          config: {
            cor: rascunho.cor,
            logoUrl: rascunho.logoUrl,
            redirectUrl: rascunho.redirectUrl,
            supportEmail: rascunho.supportEmail,
            softDescriptor: rascunho.softDescriptor,
            appmaxExternalId: rascunho.appmaxExternalId,
          },
        }),
      });

      const j = await r.json() as { erro?: string; slug?: string };
      if (!r.ok) { setErro(j.erro ?? "Falha ao gravar."); setSalvando(false); return; }

      setAviso(`Checkout salvo em /c/${j.slug}`);
      setRascunho(null);
      router.refresh();
    } catch {
      setErro("Sem conexão com o servidor.");
    }
    setSalvando(false);
  }

  async function excluir(c: CheckoutNaLista) {
    if (!confirm(`Excluir "${c.name}"? O endereço /c/${c.slug} deixa de funcionar na hora.`)) return;
    await fetch(`/api/checkouts?tenantId=${tenantId}&id=${c.id}`, { method: "DELETE" });
    setAviso(`"${c.name}" excluído.`);
    router.refresh();
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <div style={{
        padding: "16px 20px", borderBottom: "1px solid var(--linha)", background: "var(--painel)",
        display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap",
      }}>
        <div style={{ flexGrow: 1, minWidth: 260 }}>
          <h1 style={{ fontSize: 17, fontWeight: 700, margin: 0, letterSpacing: "-.2px" }}>
            Checkout próprio
          </h1>
          <p style={{ fontSize: 12, color: "var(--ink-tenue)", margin: "3px 0 0", maxWidth: 680 }}>
            A página de pagamento no seu domínio, cobrando pela Appmax. Corta a taxa
            do construtor de checkout — e, porque o clique não precisa atravessar
            domínio de terceiro, a atribuição da venda deixa de ser palpite.
          </p>
        </div>
        <button
          onClick={() => { setRascunho(rascunhoVazio(opcoes)); setErro(null); }}
          disabled={!temAppmax}
          style={{
            border: "1px solid var(--acento)", background: "var(--acento-fundo)",
            color: "var(--acento)", borderRadius: 6, padding: "8px 14px",
            fontSize: 12.5, fontWeight: 600, opacity: temAppmax ? 1 : .45,
          }}
        >
          Novo checkout
        </button>
      </div>

      <div style={{ padding: "16px 20px 30px", display: "flex", flexDirection: "column", gap: 14 }}>

        <PainelShopify tenantId={tenantId} conexoes={opcoes.lojasShopify.map((l) => ({
          id: l.id, shopDomain: l.shopDomain, label: l.label, active: true,
        }))} />

        {!temAppmax && (
          <Faixa tom="alerta">
            Nenhuma conexão da Appmax ativa nesta loja. Cadastre em{" "}
            <a href="/integracoes">Integrações</a> antes de criar um checkout — é por
            ela que a cobrança acontece.
          </Faixa>
        )}

        {aviso && <Faixa tom="ok">{aviso}</Faixa>}

        {rascunho && (
          <Formulario
            tenantId={tenantId}
            rascunho={rascunho}
            setRascunho={setRascunho}
            opcoes={opcoes}
            erro={erro}
            salvando={salvando}
            onSalvar={salvar}
            onCancelar={() => { setRascunho(null); setErro(null); }}
          />
        )}

        {checkouts.length === 0 && !rascunho ? (
          <div style={{
            border: "1px dashed var(--linha-forte)", borderRadius: 8, padding: 28,
            textAlign: "center", color: "var(--ink-tenue)", fontSize: 13, lineHeight: 1.6,
          }}>
            Nenhum checkout ainda.<br />
            Crie um, cole o link no anúncio, e a venda entra já sabendo de onde veio.
          </div>
        ) : (
          checkouts.map((c) => (
            <Linha key={c.id} c={c} base={base}
              onEditar={() => { setRascunho(paraRascunho(c)); setErro(null); }}
              onExcluir={() => excluir(c)} />
          ))
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- linha -- */

function Linha({ c, base, onEditar, onExcluir }: {
  c: CheckoutNaLista; base: string;
  onEditar: () => void; onExcluir: () => void;
}) {
  const [copiado, setCopiado] = useState(false);
  const url = `${base}/c/${c.slug}`;

  return (
    <div style={{
      background: "var(--painel)", border: "1px solid var(--linha)", borderRadius: 8,
      padding: 16, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start",
    }}>
      <div style={{ flexGrow: 1, minWidth: 250 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
          <strong style={{ fontSize: 14 }}>{c.name}</strong>
          {!c.active && (
            <span style={{
              fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em",
              color: "var(--ink-tenue)", border: "1px solid var(--linha-forte)",
              borderRadius: 4, padding: "1px 6px",
            }}>pausado</span>
          )}
        </div>

        <div style={{
          display: "flex", alignItems: "center", gap: 7, marginBottom: 9, flexWrap: "wrap",
        }}>
          <code style={{
            fontSize: 11.5, color: "var(--acento)", background: "var(--painel-alto)",
            border: "1px solid var(--linha-forte)", borderRadius: 5, padding: "4px 8px",
          }}>{url}</code>
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(url);
                setCopiado(true);
                setTimeout(() => setCopiado(false), 2000);
              } catch { /* sem permissão: o endereço está à vista para copiar na mão */ }
            }}
            style={{
              border: "1px solid var(--linha-forte)", background: "transparent",
              color: "var(--ink-fraco)", borderRadius: 5, padding: "4px 9px", fontSize: 11.5,
            }}
          >{copiado ? "copiado" : "copiar"}</button>
        </div>

        <div style={{ fontSize: 12, color: "var(--ink-tenue)", lineHeight: 1.6 }}>
          {c.items.map((i) => `${i.quantity}× ${i.name}`).join(" · ") || "sem produtos"}
          <br />
          <span className="num" style={{ color: "var(--ink-medio)", fontWeight: 600 }}>
            {brl(c.totalCents)}
          </span>
          {" · "}{c.methods.map((m) => (m === "pix" ? "Pix" : `Cartão ${c.maxInstallments}x`)).join(" e ")}
          {" · "}{c.gatewayLabel}
        </div>
      </div>

      <div style={{ textAlign: "right", minWidth: 130 }}>
        <div style={{
          fontSize: 10, textTransform: "uppercase", letterSpacing: ".06em",
          color: "var(--ink-tenue)", fontWeight: 600, marginBottom: 3,
        }}>7 dias</div>
        <div className="num" style={{ fontSize: 19, fontWeight: 700, lineHeight: 1.1 }}>
          {c.aprovadas}
          <span style={{ fontSize: 12, color: "var(--ink-tenue)", fontWeight: 400 }}>
            {" "}/ {c.tentativas}
          </span>
        </div>
        <div style={{ fontSize: 10.5, color: "var(--ink-tenue)", marginTop: 2 }}>
          aceitas / tentativas
        </div>

        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 11 }}>
          <button onClick={onEditar} style={botaoDiscreto}>editar</button>
          <button onClick={onExcluir} style={{ ...botaoDiscreto, color: "var(--negativo)" }}>
            excluir
          </button>
        </div>
      </div>
    </div>
  );
}

const botaoDiscreto: React.CSSProperties = {
  border: "1px solid var(--linha-forte)", background: "transparent",
  color: "var(--ink-fraco)", borderRadius: 5, padding: "4px 10px", fontSize: 11.5,
};

/* ----------------------------------------------------------- formulário -- */

function Formulario({ tenantId, rascunho, setRascunho, opcoes, erro, salvando, onSalvar, onCancelar }: {
  tenantId: string;
  rascunho: Rascunho;
  setRascunho: (r: Rascunho) => void;
  opcoes: OpcoesDoFormulario;
  erro: string | null;
  salvando: boolean;
  onSalvar: () => void;
  onCancelar: () => void;
}) {
  const set = <K extends keyof Rascunho>(k: K, v: Rascunho[K]) =>
    setRascunho({ ...rascunho, [k]: v });

  const setItem = (n: number, campo: keyof Item, v: string | boolean) => {
    const itens = rascunho.itens.map((i, x) => (x === n ? { ...i, [campo]: v } : i));
    setRascunho({ ...rascunho, itens });
  };

  const total = rascunho.itens.reduce((s, i) => {
    const p = centavos(i.preco);
    return s + (Number.isFinite(p) ? p * (Number(i.quantidade) || 1) : 0);
  }, 0) + (rascunho.frete.trim() && Number.isFinite(centavos(rascunho.frete))
    ? centavos(rascunho.frete) : 0);

  const conexoesAppmax = opcoes.conexoes.filter((c) => c.gateway === "appmax");
  const [escolhendo, setEscolhendo] = useState(false);

  /*
   * Traz a variante como um item novo, ja com preco e SKU da Shopify.
   *
   * Substitui a primeira linha se ela estiver em branco: quem acabou de abrir o
   * formulario tem uma linha vazia esperando, e empurrar o produto para baixo
   * dela deixaria um item fantasma que o salvamento descarta em silencio.
   */
  const importar = (v: VarianteEscolhida) => {
    const novo: Item = {
      sku: v.sku, name: v.nome, quantidade: "1",
      preco: emReais(v.precoCents), digital: false,
      shopifyVariantId: v.shopifyVariantId,
    };
    const primeira = rascunho.itens[0];
    const vazia = rascunho.itens.length === 1 && primeira
      && !primeira.name.trim() && !primeira.preco.trim();
    setRascunho({ ...rascunho, itens: vazia ? [novo] : [...rascunho.itens, novo] });
  };

  return (
    <div style={{
      background: "var(--painel)", border: "1px solid var(--acento)",
      borderRadius: 8, padding: 18,
    }}>
      <h2 style={{ fontSize: 14, margin: "0 0 14px", fontWeight: 700 }}>
        {rascunho.id ? "Editar checkout" : "Novo checkout"}
      </h2>

      <Grade>
        <Campo rotulo="Nome" dica="Só você vê. Serve para achar na lista.">
          <input value={rascunho.name} onChange={(e) => set("name", e.target.value)}
            placeholder="Kit Verão 3 peças" />
        </Campo>
        <Campo rotulo="Endereço" dica="Vira /c/isto. Em branco, sai do nome.">
          <input value={rascunho.slug} onChange={(e) => set("slug", e.target.value)}
            placeholder="kit-verao" />
        </Campo>
      </Grade>

      <Grade>
        <Campo rotulo="Gateway" dica="Hoje o checkout próprio só cobra pela Appmax.">
          <select value={rascunho.gatewayConnectionId}
            onChange={(e) => set("gatewayConnectionId", e.target.value)}>
            {conexoesAppmax.length === 0 && <option value="">nenhuma conexão Appmax</option>}
            {conexoesAppmax.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Site" dica="De qual site vem o rastreamento desta oferta.">
          <select value={rascunho.siteId} onChange={(e) => set("siteId", e.target.value)}>
            <option value="">nenhum</option>
            {opcoes.sites.map((s) => <option key={s.id} value={s.id}>{s.domain}</option>)}
          </select>
        </Campo>
      </Grade>

      {opcoes.lojasShopify.length > 0 && (
        <Grade>
          <Campo
            rotulo="Enviar pedido para"
            dica="Depois de pago, o pedido nasce la — baixando estoque e avisando o comprador."
          >
            <select value={rascunho.shopifyConnectionId}
              onChange={(e) => set("shopifyConnectionId", e.target.value)}>
              <option value="">nao enviar para a Shopify</option>
              {opcoes.lojasShopify.map((l) => (
                <option key={l.id} value={l.id}>{l.label}</option>
              ))}
            </select>
          </Campo>
        </Grade>
      )}

      <Titulo>Produtos</Titulo>
      {rascunho.itens.map((item, n) => (
        <div key={n} style={{
          display: "grid", gridTemplateColumns: "1fr 90px 120px auto auto",
          gap: 8, marginBottom: 8, alignItems: "end",
        }}>
          <Campo rotulo={n === 0 ? "Produto" : undefined}>
            <input value={item.name} onChange={(e) => setItem(n, "name", e.target.value)}
              placeholder="Nome que o comprador vê" />
            {/* Sem variante, o item entra na Shopify como linha avulsa e o
                estoque nao anda — vale dizer antes de salvar, nao depois. */}
            {rascunho.shopifyConnectionId && !item.shopifyVariantId && item.name.trim() && (
              <span style={{ fontSize: 10.5, color: "var(--alerta)", marginTop: 3, display: "block" }}>
                não veio da Shopify — não baixaria estoque
              </span>
            )}
          </Campo>
          <Campo rotulo={n === 0 ? "Qtd" : undefined}>
            <input value={item.quantidade} inputMode="numeric"
              onChange={(e) => setItem(n, "quantidade", e.target.value.replace(/\D/g, ""))} />
          </Campo>
          <Campo rotulo={n === 0 ? "Preço (R$)" : undefined}>
            <input value={item.preco} inputMode="decimal" placeholder="89,90"
              onChange={(e) => setItem(n, "preco", e.target.value)} />
          </Campo>
          <label style={{
            fontSize: 11.5, color: "var(--ink-fraco)", display: "flex",
            alignItems: "center", gap: 5, paddingBottom: 10, whiteSpace: "nowrap",
          }}>
            <input type="checkbox" checked={item.digital} style={{ width: "auto" }}
              onChange={(e) => setItem(n, "digital", e.target.checked)} />
            digital
          </label>
          <button
            onClick={() => setRascunho({
              ...rascunho,
              itens: rascunho.itens.length > 1
                ? rascunho.itens.filter((_, x) => x !== n)
                : [{ ...ITEM_VAZIO }],
            })}
            style={{ ...botaoDiscreto, marginBottom: 8 }}
          >×</button>
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, marginTop: 2, flexWrap: "wrap" }}>
        <button
          onClick={() => setRascunho({ ...rascunho, itens: [...rascunho.itens, { ...ITEM_VAZIO }] })}
          style={botaoDiscreto}
        >+ produto</button>

        {rascunho.shopifyConnectionId && (
          <button onClick={() => setEscolhendo(true)} style={{
            ...botaoDiscreto,
            borderColor: "var(--acento)", color: "var(--acento)",
          }}>+ importar da Shopify</button>
        )}
      </div>

      {escolhendo && rascunho.shopifyConnectionId && (
        <SeletorDeProduto
          tenantId={tenantId}
          conexaoId={rascunho.shopifyConnectionId}
          aoEscolher={importar}
          aoFechar={() => setEscolhendo(false)}
        />
      )}

      <Grade>
        <Campo rotulo="Frete (R$)" dica="Em branco ou zero mostra 'Grátis'.">
          <input value={rascunho.frete} inputMode="decimal" placeholder="0,00"
            onChange={(e) => set("frete", e.target.value)} />
        </Campo>
        <Campo rotulo="Máximo de parcelas">
          <select value={rascunho.maxInstallments}
            onChange={(e) => set("maxInstallments", Number(e.target.value))}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>{n}x</option>
            ))}
          </select>
        </Campo>
      </Grade>

      <Titulo>Formas de pagamento</Titulo>
      <div style={{ display: "flex", gap: 16, marginBottom: 4 }}>
        {[["pix", "Pix"], ["credit_card", "Cartão de crédito"]].map(([id, rotulo]) => (
          <label key={id} style={{
            fontSize: 12.5, color: "var(--ink-medio)", display: "flex",
            alignItems: "center", gap: 6,
          }}>
            <input type="checkbox" style={{ width: "auto" }}
              checked={rascunho.metodos.includes(id!)}
              onChange={(e) => set("metodos", e.target.checked
                ? [...rascunho.metodos, id!]
                : rascunho.metodos.filter((m) => m !== id))} />
            {rotulo}
          </label>
        ))}
      </div>

      <Titulo>Aparência e destino</Titulo>
      <Grade>
        <Campo rotulo="Cor principal" dica="Hex, ex. #E11D48. Em branco usa cinza escuro.">
          <input value={rascunho.cor} onChange={(e) => set("cor", e.target.value)}
            placeholder="#111827" />
        </Campo>
        <Campo rotulo="Logo (URL)">
          <input value={rascunho.logoUrl} onChange={(e) => set("logoUrl", e.target.value)}
            placeholder="https://.../logo.png" />
        </Campo>
      </Grade>
      <Grade>
        <Campo rotulo="Página de obrigado" dica="Para onde ir depois do pagamento aprovado.">
          <input value={rascunho.redirectUrl} onChange={(e) => set("redirectUrl", e.target.value)}
            placeholder="https://sualoja.com/obrigado" />
        </Campo>
        <Campo rotulo="E-mail de suporte">
          <input value={rascunho.supportEmail} onChange={(e) => set("supportEmail", e.target.value)}
            placeholder="ajuda@sualoja.com" />
        </Campo>
      </Grade>
      <Grade>
        <Campo rotulo="Nome na fatura" dica="Até 13 caracteres. É o que aparece no cartão do comprador.">
          <input value={rascunho.softDescriptor} maxLength={13}
            onChange={(e) => set("softDescriptor", e.target.value)} placeholder="SUALOJA" />
        </Campo>
        <Campo rotulo="External ID da Appmax" dica="Exigido pela tokenização do cartão. Está no painel da Appmax.">
          <input value={rascunho.appmaxExternalId}
            onChange={(e) => set("appmaxExternalId", e.target.value)} />
        </Campo>
      </Grade>

      <label style={{
        fontSize: 12.5, color: "var(--ink-medio)", display: "flex",
        alignItems: "center", gap: 6, marginTop: 14,
      }}>
        <input type="checkbox" checked={rascunho.active} style={{ width: "auto" }}
          onChange={(e) => set("active", e.target.checked)} />
        Ativo — desmarcado, o endereço para de aceitar pagamento
      </label>

      {erro && (
        <div style={{
          background: "var(--negativo-fundo)", border: "1px solid var(--negativo)",
          borderRadius: 6, padding: "9px 12px", fontSize: 12.5,
          color: "var(--negativo)", marginTop: 14,
        }}>{erro}</div>
      )}

      <div style={{
        display: "flex", gap: 9, marginTop: 16, alignItems: "center", flexWrap: "wrap",
      }}>
        <button onClick={onSalvar} disabled={salvando} style={{
          border: "1px solid var(--acento)", background: "var(--acento-fundo)",
          color: "var(--acento)", borderRadius: 6, padding: "9px 18px",
          fontSize: 12.5, fontWeight: 600, opacity: salvando ? .6 : 1,
        }}>{salvando ? "salvando..." : "Salvar checkout"}</button>

        <button onClick={onCancelar} style={botaoDiscreto}>cancelar</button>

        <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--ink-fraco)" }}>
          Total da oferta: <span className="num" style={{
            color: "var(--ink)", fontWeight: 600,
          }}>{brl(total)}</span>
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ pedacinhos -- */

const Grade = ({ children }: { children: React.ReactNode }) => (
  <div style={{
    display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 10,
  }}>{children}</div>
);

const Titulo = ({ children }: { children: React.ReactNode }) => (
  <div style={{
    fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".07em",
    color: "var(--ink-tenue)", fontWeight: 600, margin: "18px 0 9px",
  }}>{children}</div>
);

function Campo({ rotulo, dica, children }: {
  rotulo?: string; dica?: string; children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block", marginBottom: 8 }}>
      {rotulo && (
        <span style={{
          display: "block", fontSize: 11.5, color: "var(--ink-fraco)",
          marginBottom: 4, fontWeight: 500,
        }}>{rotulo}</span>
      )}
      {children}
      {dica && (
        <span style={{
          display: "block", fontSize: 10.5, color: "var(--ink-tenue)", marginTop: 3,
        }}>{dica}</span>
      )}
    </label>
  );
}

function Faixa({ tom, children }: { tom: "ok" | "alerta"; children: React.ReactNode }) {
  const cores = tom === "ok"
    ? { fundo: "var(--positivo-fundo)", borda: "var(--positivo)", texto: "var(--positivo)" }
    : { fundo: "var(--alerta-fundo)", borda: "var(--alerta)", texto: "var(--alerta)" };

  return (
    <div style={{
      background: cores.fundo, border: `1px solid ${cores.borda}`, borderRadius: 8,
      padding: "11px 14px", fontSize: 12.5, color: cores.texto, lineHeight: 1.55,
    }}>{children}</div>
  );
}
