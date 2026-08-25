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

/*
 * O placar SEMPRE tira frete e juros, qualquer que seja a regra da loja.
 *
 * As duas coisas são dinheiro de passagem: o frete vai para o transportador e
 * o juro do parcelamento fica com o gateway. Nenhum dos dois é o que a
 * operação produziu, e um troféu que sobe com dinheiro alheio não vale como
 * troféu.
 *
 * A regra da loja continua valendo em tudo que serve para DECIDIR — ROAS,
 * lucro, margem — porque lá o que importa é comparar receita com gasto, e
 * quem embute o frete no preço precisa contá-lo para a conta fechar. Aqui não
 * se decide nada; se olha distância. São perguntas diferentes.
 *
 * Quem embute o frete no preço não é prejudicado: nesse caso `shipping_cents`
 * é nulo ou zero, e subtrair nada não muda nada.
 */
export const REGRA_PLACAR: RegraFaturamento = { countShipping: false, countInterest: false };

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
  /** A próxima marca. `null` quando passou da última — aí não há teto. */
  ateCents: number | null;
  /*
   * Preenchimento da barra, de 0 a 1, medido contra a próxima marca — e não
   * dentro da faixa atual.
   *
   * A tela mostra dois números: o acumulado e a marca no fim da barra. O
   * preenchimento tem que ser a razão entre esses dois, senão a barra
   * contradiz o que está escrito nela: com 60 mil rumo a 100 mil, medir dentro
   * da faixa daria 20% de barra ao lado de um número que qualquer um lê como
   * 60% do caminho.
   */
  progresso: number;
}

export function faixaDe(totalCents: number): Placar {
  for (const ate of FAIXAS) {
    if (totalCents < ate) {
      return {
        totalCents,
        ateCents: ate,
        progresso: ate > 0 ? totalCents / ate : 0,
      };
    }
  }

  /* Passou da última marca: não há próxima meta, a barra fica cheia. */
  return { totalCents, ateCents: null, progresso: 1 };
}

/** Soma tudo que a loja já recebeu, desde sempre. */
export async function faturamentoAcumulado(
  tenantId: string,
  regra: RegraFaturamento = REGRA_PLACAR,
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

/*
 * Não recebe regra de propósito: o placar não é configurável por loja. Aceitar
 * uma aqui convidaria um chamador distraído a passar a regra da loja e fazer o
 * troféu de um dashboard medir coisa diferente do de outro.
 */
export async function placarDaLoja(tenantId: string): Promise<Placar> {
  return faixaDe(await faturamentoAcumulado(tenantId, REGRA_PLACAR));
}
