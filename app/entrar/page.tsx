"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Entrar() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    setEnviando(true);

    try {
      const r = await fetch("/api/auth/entrar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, senha }),
      });

      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErro(j.erro ?? "não foi possível entrar");
        setEnviando(false);
        return;
      }

      /* `refresh` antes de navegar: sem isso o servidor devolveria a página
         renderizada com a sessão antiga, ainda vazia. */
      router.refresh();
      router.push("/");
    } catch {
      setErro("sem conexão com o servidor");
      setEnviando(false);
    }
  }

  return (
    <main style={{
      minHeight: "100vh", display: "flex", alignItems: "center",
      justifyContent: "center", padding: 24,
    }}>
      <div style={{ width: "100%", maxWidth: 360 }}>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 30 }}>
          <svg width="24" height="24" viewBox="0 0 18 18" fill="none" stroke="var(--acento)" strokeWidth="1.6">
            <circle cx="9" cy="9" r="1.8" fill="var(--acento)" stroke="none" />
            <path d="M4.2 4.2a6.8 6.8 0 0 0 0 9.6M13.8 4.2a6.8 6.8 0 0 1 0 9.6" />
            <path d="M1.6 1.6a10.4 10.4 0 0 0 0 14.8M16.4 1.6a10.4 10.4 0 0 1 0 14.8" opacity=".45" />
          </svg>
          <span style={{ fontWeight: 700, fontSize: 18, letterSpacing: "-.3px" }}>RRTrack</span>
        </div>

        <form onSubmit={enviar} style={{
          background: "var(--painel)", border: "1px solid var(--linha)",
          borderRadius: 8, padding: "24px 24px 22px",
        }}>
          <h1 style={{
            fontSize: 16, fontWeight: 600, margin: "0 0 4px", letterSpacing: "-.2px",
          }}>Entrar</h1>
          <p style={{ fontSize: 12.5, color: "var(--ink-fraco)", margin: "0 0 20px" }}>
            Acesse o painel das suas lojas.
          </p>

          <label style={{ display: "block", marginBottom: 14 }}>
            <span style={{
              display: "block", fontSize: 10.5, letterSpacing: ".07em",
              textTransform: "uppercase", color: "var(--ink-tenue)",
              fontWeight: 600, marginBottom: 6,
            }}>E-mail</span>
            <input
              type="email" value={email} required autoFocus autoComplete="username"
              onChange={(e) => setEmail(e.target.value)}
              placeholder="voce@exemplo.com"
            />
          </label>

          <label style={{ display: "block", marginBottom: 18 }}>
            <span style={{
              display: "block", fontSize: 10.5, letterSpacing: ".07em",
              textTransform: "uppercase", color: "var(--ink-tenue)",
              fontWeight: 600, marginBottom: 6,
            }}>Senha</span>
            <input
              type="password" value={senha} required autoComplete="current-password"
              onChange={(e) => setSenha(e.target.value)}
              placeholder="••••••••••••"
            />
          </label>

          {erro && (
            <div style={{
              background: "var(--negativo-fundo)", border: "1px solid var(--negativo)",
              borderRadius: 5, padding: "9px 12px", marginBottom: 16,
              fontSize: 12.5, color: "var(--negativo)",
            }}>{erro}</div>
          )}

          <button type="submit" disabled={enviando} style={{
            width: "100%", padding: "10px 0", borderRadius: 5, border: "none",
            background: enviando ? "var(--linha-forte)" : "var(--acento)",
            color: enviando ? "var(--ink-fraco)" : "#062026",
            fontWeight: 600, fontSize: 13,
            cursor: enviando ? "default" : "pointer",
          }}>
            {enviando ? "entrando…" : "Entrar"}
          </button>
        </form>

        <p style={{
          fontSize: 11.5, color: "var(--ink-tenue)", textAlign: "center",
          margin: "18px 0 0", lineHeight: 1.5,
        }}>
          Sem conta ainda? Ela é criada pelo terminal,<br />
          com <span className="num">scripts/criar-usuario.mjs</span>
        </p>
      </div>
    </main>
  );
}
