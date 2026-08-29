"use client";

import { createContext, useCallback, useContext } from "react";

import { casasDecimais } from "@/core/moeda";

/*
 * Dinheiro na tela, na moeda da loja.
 *
 * Existe porque o painel escrevia "R$" na mão, em três arquivos diferentes.
 * Enquanto só houvesse loja no Brasil isso passava; com uma loja em libra, a
 * tela mostraria "R$ 1.234,56" para £1.234,56 — número errado com cara de
 * certo, que é o tipo de erro que este projeto mais pagou caro.
 *
 * A moeda entra uma vez, no layout do painel, e desce por contexto. A
 * alternativa era passar `moeda` como propriedade por sete componentes até as
 * vinte e três chamadas — e bastaria esquecer uma para o "R$" voltar sozinho
 * numa tela só.
 *
 * O padrão é BRL para a loja que existia antes desta coluna significar algo.
 */

const MoedaContexto = createContext<string>("BRL");

export function ProvedorDeMoeda({
  moeda,
  children,
}: {
  moeda: string;
  children: React.ReactNode;
}) {
  return (
    <MoedaContexto.Provider value={moeda || "BRL"}>
      {children}
    </MoedaContexto.Provider>
  );
}

/*
 * Cada moeda tem a convenção de escrita do lugar dela.
 *
 * £1,234.56 e R$ 1.234,56 trocam ponto e vírgula de papel. Formatar libra com
 * regra brasileira produz um número legível e estranho — e quem lê rápido não
 * percebe que a casa dos milhares virou decimal.
 */
const LOCAL: Record<string, string> = {
  BRL: "pt-BR",
  USD: "en-US",
  GBP: "en-GB",
  EUR: "de-DE",
  CAD: "en-CA",
  AUD: "en-AU",
  MXN: "es-MX",
  CLP: "es-CL",
  COP: "es-CO",
  ARS: "es-AR",
  PYG: "es-PY",
  JPY: "ja-JP",
};

function localDe(moeda: string): string {
  return LOCAL[moeda.toUpperCase()] ?? "pt-BR";
}

/*
 * Quantas casas a moeda tem — a regra mora em core/moeda.ts, e não aqui.
 *
 * Não são sempre duas: iene e guarani não têm centavo nenhum. Guardamos tudo
 * na menor unidade, então dividir por 100 estaria errado nesses casos — o
 * valor apareceria cem vezes menor.
 *
 * É a MESMA conta que o adaptador da Shopify usa para ler "129.95" e virar
 * 12995. Duas cópias dessa regra divergiriam, e o número entraria por uma
 * porta e sairia diferente pela outra sem erro nenhum acusando.
 */
const casas = casasDecimais;

function formatar(cents: number, moeda: string): string {
  const m = (moeda || "BRL").toUpperCase();
  const divisor = 10 ** casas(m);
  try {
    return new Intl.NumberFormat(localDe(m), {
      style: "currency",
      currency: m,
      minimumFractionDigits: casas(m),
      maximumFractionDigits: casas(m),
    }).format(cents / divisor);
  } catch {
    /* Código de moeda desconhecido não pode derrubar a tela inteira. */
    return `${m} ${(cents / divisor).toFixed(casas(m))}`;
  }
}

/*
 * Versão curta, para cartão apertado: 1,2 mil em vez do valor inteiro.
 *
 * O sufixo vem do próprio Intl, então "mil" em português e "K" em inglês —
 * traduzir na mão daria "1.2k" numa tela em português.
 */
function formatarCurto(cents: number, moeda: string): string {
  const m = (moeda || "BRL").toUpperCase();
  const divisor = 10 ** casas(m);
  const v = cents / divisor;

  if (Math.abs(v) < 1000) return formatar(cents, m);

  try {
    return new Intl.NumberFormat(localDe(m), {
      style: "currency",
      currency: m,
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(v);
  } catch {
    return formatar(cents, m);
  }
}

/** O código da moeda desta loja — para quem precisa comparar, não exibir. */
export function useMoeda(): string {
  return useContext(MoedaContexto);
}

/**
 * O formatador de dinheiro desta loja.
 *
 *   const dinheiro = useDinheiro();
 *   dinheiro(12345)            → R$ 123,45  ·  £123.45
 *   dinheiro(1234500, true)    → R$ 12,3 mil
 *   dinheiro(null)             → N/A
 */
export function useDinheiro() {
  const moeda = useContext(MoedaContexto);
  return useCallback(
    (cents: number | null | undefined, curto = false): string => {
      if (cents === null || cents === undefined) return "N/A";
      return curto ? formatarCurto(cents, moeda) : formatar(cents, moeda);
    },
    [moeda],
  );
}
