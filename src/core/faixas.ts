/*
 * Faturamento acumulado da loja e a faixa em que ele está.
 *
 * É placar, não relatório: soma tudo que já foi pago desde o primeiro dia e
 * nunca reinicia. Por isso as faixas crescem de forma desigual — de 10 mil
 * para 50 mil é o começo, de 1 milhão para 2 milhões é outra vida, e uma
 * régua linear achataria as duas coisas na mesma barra.
 *
 * Conta só venda paga. Pendente não é faturamento, e reembolso e chargeback
 * saem — um placar que sobe com dinheiro que voltou mente para quem olha.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index";
import { orders } from "../db/schema";
import { REGRA_PADRAO, valorDaVenda, type RegraFaturamento } from "./faturamento";

/** Fronteiras em centavos: 10 mil, 50 mil, 100 mil, 500 mil, 1 mi, 2 mi... */
export const FAIXAS = [
  1_000_000,
  5_000_000,
  10_000_000,
  50_000_000,
  100_000_000,
  200_000_000,
  500_000_000,
  1_000_000_000,
] as const;

export interface Placar {
  totalCents: number;
  /** Início da faixa atual, em centavos. Zero na primeira. */
  deCents: number;
  /** Fim da faixa atual. `null` quando passou da última — aí não há teto. */
  ateCents: number | null;
  /** Quanto falta para a próxima fronteira. `null` quando não há próxima. */
  faltamCents: number | null;
  /** Progresso dentro da faixa atual, de 0 a 1. */
  progresso: number;
  /** Em que degrau está, a partir de 1. */
  degrau: number;
  totalDegraus: number;
}

export function faixaDe(totalCents: number): Placar {
  const base = {
    totalCents,
    degrau: FAIXAS.length + 1,
    totalDegraus: FAIXAS.length + 1,
  };

  for (let i = 0; i < FAIXAS.length; i++) {
    const ate = FAIXAS[i]!;
    if (totalCents < ate) {
      const de = i === 0 ? 0 : FAIXAS[i - 1]!;
      const largura = ate - de;
      return {
        ...base,
        deCents: de,
        ateCents: ate,
        faltamCents: ate - totalCents,
        /*
         * Progresso dentro da faixa, não do total. Uma loja com 60 mil está a
         * 20% do caminho entre 50 e 100 mil — mostrar 6% de um milhão faria a
         * barra parecer parada por meses.
         */
        progresso: largura > 0 ? (totalCents - de) / largura : 0,
        degrau: i + 1,
      };
    }
  }

  /* Passou da última fronteira: não há próxima meta, a barra fica cheia. */
  return {
    ...base,
    deCents: FAIXAS[FAIXAS.length - 1]!,
    ateCents: null,
    faltamCents: null,
    progresso: 1,
  };
}

/** Soma tudo que a loja já recebeu, desde sempre. */
export async function faturamentoAcumulado(
  tenantId: string,
  regra: RegraFaturamento = REGRA_PADRAO,
): Promise<number> {
  const [linha] = await db
    .select({ total: sql<string>`coalesce(sum(${valorDaVenda(regra)}), 0)::bigint` })
    .from(orders)
    .where(and(
      eq(orders.tenantId, tenantId),
      /*
       * `inArray` com um valor só em vez de `eq` porque a lista tende a
       * crescer: no dia em que "aprovado com entrega pendente" existir, entra
       * aqui e não numa condição nova espalhada por outro arquivo.
       */
      inArray(orders.status, ["paid"]),
    ));

  return Number(linha?.total ?? 0);
}

export async function placarDaLoja(
  tenantId: string,
  regra: RegraFaturamento = REGRA_PADRAO,
): Promise<Placar> {
  return faixaDe(await faturamentoAcumulado(tenantId, regra));
}
