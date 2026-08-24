"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Cartao, Nota, SemDado, brl, num } from "./comum";
import type { CustoDeSku } from "@/core/custos";

/*
 * Custo por produto.
 *
 * A lista sai das VENDAS, não do cadastro — assim o que falta preencher
 * aparece sozinho, em vez de o lojista ter que lembrar quais SKUs existem. E o
 * que falta preencher é exatamente o que distorce o lucro.
 */

export function Produtos({
  tenantId, skus,
}: {
  tenantId: string;
  skus: CustoDeSku[];
}) {
  const router = useRouter();
  const [editando, setEditando] = useState<string | null>(null);
  const [valor, setValor] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  const semCusto = skus.filter((s) => s.custoCents === null && s.vendas > 0);
  const faturamentoSemCusto = semCusto.reduce((t, s) => t + s.faturamentoCents, 0);
  const faturamentoTotal = skus.reduce((t, s) => t + s.faturamentoCents, 0);

  async function salvar(sku: string) {
    const reais = parseFloat(valor.replace(/\./g, "").replace(",", "."));
    if (!Number.isFinite(reais) || reais < 0) {
      setAviso("valor inválido");
      return;
    }
    setSalvando(true);
    setAviso(null);
    try {
      const r = await fetch("/api/produtos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId, sku, custo: reais }),
      });
      const j = await r.json();
      if (!r.ok) { setAviso(j.erro ?? "falha ao gravar"); setSalvando(false); return; }
      setAviso(j.recalculadas > 0
        ? `${j.recalculadas} venda(s) recalculada(s) com o novo custo`
        : "custo gravado");
      setEditando(null);
      setValor("");
      router.refresh();
    } catch {
      setAviso("sem conexão com o servidor");
    }
    setSalvando(false);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <div style={{
        padding: "16px 20px", borderBottom: "1px solid var(--linha)", background: "var(--painel)",
      }}>
        <h1 style={{ fontSize: 17, fontWeight: 700, margin: 0, letterSpacing: "-.2px" }}>Produtos</h1>
        <p style={{ fontSize: 12, color: "var(--ink-tenue)", margin: "3px 0 0", maxWidth: 640 }}>
          Quanto cada produto custa para você. É isto que separa lucro de margem sobre o anúncio.
        </p>
      </div>

      <div style={{ padding: "16px 20px 28px", display: "flex", flexDirection: "column", gap: 14 }}>

        {semCusto.length > 0 && (
          <div style={{
            padding: "13px 17px", borderRadius: 8, maxWidth: 900,
            background: "var(--alerta-fundo)", border: "1px solid var(--alerta)",
            fontSize: 12.5, color: "var(--ink-medio)", lineHeight: 1.55,
          }}>
            <strong style={{ color: "var(--alerta)" }}>
              {semCusto.length} produto(s) sem custo cadastrado.
            </strong>{" "}
            Eles responderam por <span className="num">{brl(faturamentoSemCusto)}</span> de
            faturamento{faturamentoTotal > 0 && (
              <> — <span className="num">{Math.round((faturamentoSemCusto / faturamentoTotal) * 100)}%</span> do total</>
            )}. Enquanto o custo faltar, o lucro desses pedidos aparece maior do que é.
          </div>
        )}

        {aviso && (
          <div style={{
            padding: "10px 14px", borderRadius: 6, maxWidth: 900,
            background: "var(--painel-alto)", border: "1px solid var(--linha-forte)",
            fontSize: 12.5, color: "var(--ink-medio)",
          }}>{aviso}</div>
        )}

        {skus.length === 0 ? (
          <SemDado
            titulo="Nenhum produto ainda"
            texto="A lista se preenche sozinha conforme as vendas chegam, com o SKU que o gateway informar. Não há nada para cadastrar antes da primeira venda."
          />
        ) : (
          <Cartao>
            <div style={{
              display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr 1.4fr",
              padding: "8px 0", borderBottom: "1px solid var(--linha-forte)",
              fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase",
              color: "var(--ink-tenue)", fontWeight: 600,
            }}>
              <div>SKU</div>
              <div style={{ textAlign: "right" }}>Vendas</div>
              <div style={{ textAlign: "right" }}>Faturamento</div>
              <div style={{ textAlign: "right" }}>Custo unitário</div>
              <div style={{ textAlign: "right" }}>Margem bruta</div>
            </div>

            {skus.map((s) => {
              const emEdicao = editando === s.sku;
              const precoMedio = s.vendas ? s.faturamentoCents / s.vendas : null;
              const margem = s.custoCents !== null && precoMedio
                ? ((precoMedio - s.custoCents) / precoMedio) * 100
                : null;

              return (
                <div key={s.sku} style={{
                  display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr 1.4fr",
                  padding: "10px 0", borderBottom: "1px solid var(--linha)",
                  alignItems: "center", fontSize: 12,
                }}>
                  <div className="num" style={{ fontWeight: 500 }}>{s.sku}</div>
                  <div className="num" style={{ textAlign: "right", color: "var(--ink-fraco)" }}>{num(s.vendas)}</div>
                  <div className="num" style={{ textAlign: "right" }}>{brl(s.faturamentoCents)}</div>

                  <div style={{ textAlign: "right" }}>
                    {emEdicao ? (
                      <input
                        autoFocus
                        value={valor}
                        onChange={(e) => setValor(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") salvar(s.sku);
                          if (e.key === "Escape") { setEditando(null); setValor(""); }
                        }}
                        placeholder="0,00"
                        style={{ textAlign: "right", padding: "5px 8px", maxWidth: 110 }}
                      />
                    ) : (
                      <button
                        onClick={() => {
                          setEditando(s.sku);
                          setValor(s.custoCents !== null ? (s.custoCents / 100).toFixed(2).replace(".", ",") : "");
                          setAviso(null);
                        }}
                        className="num"
                        style={{
                          background: "none", border: "none", padding: "2px 6px", borderRadius: 4,
                          color: s.custoCents === null ? "var(--alerta)" : "var(--ink)",
                          fontSize: 12, fontWeight: s.custoCents === null ? 600 : 500,
                          textDecoration: "underline", textDecorationStyle: "dotted",
                          textUnderlineOffset: 3,
                        }}
                      >{s.custoCents === null ? "cadastrar" : brl(s.custoCents)}</button>
                    )}
                  </div>

                  <div style={{ textAlign: "right" }}>
                    {emEdicao ? (
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <button onClick={() => salvar(s.sku)} disabled={salvando} style={{
                          padding: "5px 12px", borderRadius: 4, border: "none",
                          background: "var(--acento)", color: "#062026", fontSize: 11.5, fontWeight: 600,
                        }}>{salvando ? "…" : "Salvar"}</button>
                        <button onClick={() => { setEditando(null); setValor(""); }} style={{
                          padding: "5px 10px", borderRadius: 4,
                          border: "1px solid var(--linha-forte)", background: "transparent",
                          color: "var(--ink-fraco)", fontSize: 11.5,
                        }}>Cancelar</button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", alignItems: "baseline", gap: 8, justifyContent: "flex-end" }}>
                        <span className="num" style={{
                          fontWeight: 600,
                          color: margem === null ? "var(--ink-tenue)"
                            : margem >= 50 ? "var(--positivo)"
                            : margem >= 25 ? "var(--acento)"
                            : margem > 0 ? "var(--alerta)" : "var(--negativo)",
                        }}>
                          {margem === null ? "—" : margem.toFixed(1).replace(".", ",") + "%"}
                        </span>
                        {s.versoes > 1 && (
                          <span className="num" style={{ fontSize: 9.5, color: "var(--ink-tenue)" }}
                            title={`${s.versoes} versões de custo; vigente desde ${s.desde}`}>
                            {s.versoes} versões
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </Cartao>
        )}

        <Nota>
          Cadastrar um custo <strong style={{ color: "var(--ink-fraco)" }}>recalcula as vendas
          que já existiam</strong>, senão só o futuro teria lucro certo. E o custo tem
          vigência: reajuste do fornecedor cria uma versão nova e o histórico continua com
          o custo da época — o lucro do mês passado não se reescreve sozinho.
        </Nota>
      </div>
    </div>
  );
}
