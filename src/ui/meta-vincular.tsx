"use client";

/*
 * A tela de escolha do login com o Facebook.
 *
 * Ela existe para uma decisão que só a pessoa consegue tomar: entre as contas
 * de anúncio e os pixels que o perfil dela enxerga, quais pertencem a ESTA
 * loja. O perfil de quem gerencia várias marcas costuma ver dezenas, e vincular
 * tudo encheria o painel de contas que nunca vão gastar.
 *
 * Por padrão nada vem marcado. Marcar tudo pareceria gentileza e viraria uma
 * chamada de sincronização por hora para cada conta morta, para sempre.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Cartao } from "./comum";

interface Conta {
  id: string;
  nome: string;
  moeda: string;
  ativa: boolean;
  empresa?: string;
}

interface Pixel {
  id: string;
  nome: string;
  origem?: string;
}

interface Recursos {
  loja: { id: string; nome: string };
  expiraEm: string | null;
  contas: Conta[];
  pixels: Pixel[];
}

/*
 * Marcar tudo de uma vez.
 *
 * Um perfil que administra várias marcas lista dezenas de contas, e marcar uma
 * a uma é onde a pessoa desiste no meio e vincula pela metade. Continua sendo
 * um clique DELA: o padrão segue sendo nada marcado, porque vincular conta que
 * não vai gastar cria sincronização por hora para sempre.
 */
function Todos({ total, marcados, alternar }: {
  total: number; marcados: number; alternar: (ligar: boolean) => void;
}) {
  if (total < 2) return null;
  const tudo = marcados === total;

  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      marginBottom: 9, fontSize: 11.5, color: "var(--ink-tenue)",
    }}>
      <span>{marcados} de {total} marcados</span>
      <button onClick={() => alternar(!tudo)} style={{
        background: "none", border: "none", padding: 0,
        fontSize: 11.5, fontWeight: 600, color: "var(--acento)",
      }}>{tudo ? "desmarcar todas" : "marcar todas"}</button>
    </div>
  );
}

function Linha({ marcado, alternar, titulo, detalhe, aviso }: {
  marcado: boolean;
  alternar: () => void;
  titulo: string;
  detalhe: string;
  aviso?: string;
}) {
  return (
    <label style={{
      display: "flex", alignItems: "center", gap: 11,
      padding: "10px 12px", borderRadius: 6, cursor: "pointer",
      border: `1px solid ${marcado ? "var(--acento)" : "var(--linha)"}`,
      background: marcado ? "var(--acento-fundo, transparent)" : "transparent",
      marginBottom: 7,
    }}>
      <input type="checkbox" checked={marcado} onChange={alternar} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 12.5, fontWeight: 600 }}>{titulo}</span>
        <span className="num" style={{ display: "block", fontSize: 11, color: "var(--ink-tenue)" }}>
          {detalhe}
        </span>
      </span>
      {aviso && (
        <span style={{
          fontSize: 10, padding: "2px 7px", borderRadius: 10,
          background: "var(--linha)", color: "var(--ink-tenue)", whiteSpace: "nowrap",
        }}>{aviso}</span>
      )}
    </label>
  );
}

export function MetaVincular() {
  const router = useRouter();
  const [dados, setDados] = useState<Recursos | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [contasSel, setContasSel] = useState<string[]>([]);
  const [pixelsSel, setPixelsSel] = useState<string[]>([]);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    fetch("/api/meta/vincular")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) { setErro(j.erro ?? "falha ao listar"); return; }
        setDados(j);
      })
      .catch(() => setErro("sem conexão com o servidor"));
  }, []);

  function alternar(lista: string[], set: (v: string[]) => void, id: string) {
    set(lista.includes(id) ? lista.filter((x) => x !== id) : [...lista, id]);
  }

  async function vincular() {
    if (!dados) return;
    setSalvando(true);
    setErro(null);

    const r = await fetch("/api/meta/vincular", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenantId: dados.loja.id,
        contas: dados.contas.filter((c) => contasSel.includes(c.id))
          .map((c) => ({ id: c.id, label: c.nome })),
        pixels: dados.pixels.filter((p) => pixelsSel.includes(p.id))
          .map((p) => ({ id: p.id, label: p.nome })),
      }),
    }).catch(() => null);

    if (!r || !r.ok) {
      setErro((r && (await r.json().catch(() => null))?.erro) || "falha ao vincular");
      setSalvando(false);
      return;
    }

    router.push("/integracoes");
    router.refresh();
  }

  if (erro && !dados) {
    return (
      <div style={{ padding: 28, maxWidth: 620 }}>
        <Cartao titulo="Não deu para continuar">
          <p style={{ fontSize: 12.5, color: "var(--ink-fraco)", margin: "0 0 14px" }}>{erro}</p>
          <a href="/integracoes" style={{ fontSize: 12.5, color: "var(--acento)" }}>
            voltar às integrações
          </a>
        </Cartao>
      </div>
    );
  }

  if (!dados) {
    return <div style={{ padding: 28, fontSize: 12.5, color: "var(--ink-tenue)" }}>lendo o que o perfil enxerga…</div>;
  }

  const nada = contasSel.length === 0 && pixelsSel.length === 0;

  return (
    <div style={{ padding: 28, maxWidth: 720, display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <h1 style={{ fontSize: 17, fontWeight: 700, margin: 0, letterSpacing: "-.2px" }}>
          O que pertence a {dados.loja.nome}?
        </h1>
        <p style={{ fontSize: 12, color: "var(--ink-tenue)", margin: "4px 0 0" }}>
          Marque só o que for desta loja. Dá para vincular mais depois, sem refazer o login.
        </p>
      </div>

      <Cartao
        titulo="Contas de anúncio"
        descricao="De onde vem o gasto. Sem elas o painel mostra faturamento sem custo."
      >
        {dados.contas.length === 0
          ? <p style={{ fontSize: 12, color: "var(--ink-tenue)", margin: 0 }}>
              Este perfil não administra nenhuma conta de anúncio.
            </p>
          : <>
            <Todos
              total={dados.contas.length}
              marcados={contasSel.length}
              alternar={(ligar) => setContasSel(ligar ? dados.contas.map((c) => c.id) : [])}
            />
            {dados.contas.map((c) => (
              <Linha
                key={c.id}
                marcado={contasSel.includes(c.id)}
                alternar={() => alternar(contasSel, setContasSel, c.id)}
                titulo={c.nome}
                detalhe={`act_${c.id} · ${c.moeda}${c.empresa ? " · " + c.empresa : ""}`}
                aviso={c.ativa ? undefined : "inativa na Meta"}
              />
            ))}
          </>}
      </Cartao>

      <Cartao
        titulo="Pixels"
        descricao="Para onde as conversões são enviadas pelo servidor."
      >
        {dados.pixels.length === 0
          ? <p style={{ fontSize: 12, color: "var(--ink-tenue)", margin: 0 }}>
              Nenhum pixel encontrado nas contas deste perfil.
            </p>
          : <>
            <Todos
              total={dados.pixels.length}
              marcados={pixelsSel.length}
              alternar={(ligar) => setPixelsSel(ligar ? dados.pixels.map((p) => p.id) : [])}
            />
            {dados.pixels.map((p) => (
              <Linha
                key={p.id}
                marcado={pixelsSel.includes(p.id)}
                alternar={() => alternar(pixelsSel, setPixelsSel, p.id)}
                titulo={p.nome}
                detalhe={`${p.id}${p.origem ? " · via " + p.origem : ""}`}
              />
            ))}
          </>}
      </Cartao>

      {erro && (
        <div style={{ fontSize: 12, color: "var(--negativo, #d66)" }}>{erro}</div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <button onClick={vincular} disabled={nada || salvando} style={{
          padding: "9px 16px", borderRadius: 5, border: "none",
          fontWeight: 600, fontSize: 12.5,
          background: nada ? "var(--linha)" : "var(--acento)",
          color: nada ? "var(--ink-tenue)" : "#062026",
        }}>
          {salvando ? "vinculando…" : "Vincular à loja"}
        </button>
        <a href="/integracoes" style={{ fontSize: 12.5, color: "var(--ink-tenue)" }}>cancelar</a>
      </div>

      {/*
        * O prazo é a informação que evita a falha silenciosa mais comum desta
        * integração: o token de usuário vence, a sincronização para, e ninguém
        * percebe porque nada dá erro na tela.
        */}
      {dados.expiraEm && (
        <p style={{ fontSize: 11.5, color: "var(--ink-tenue)", margin: 0 }}>
          Esta autorização vale até{" "}
          <strong style={{ color: "var(--ink-medio)" }}>
            {new Date(dados.expiraEm).toLocaleDateString("pt-BR")}
          </strong>
          . Perto da data o painel avisa para reconectar — são os mesmos dois cliques.
        </p>
      )}
    </div>
  );
}
