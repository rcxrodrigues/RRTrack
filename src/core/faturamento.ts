/*
 * O que conta como faturamento.
 *
 * Existe um único lugar decidindo isso, e é este. Espalhar a regra por
 * metricas.ts, resumo.ts e faixas.ts garantiria que um dia os três
 * discordassem — e a divergência apareceria como "o ROAS da tela de Meta não
 * bate com o do Resumo", que é o tipo de erro que destrói a confiança no
 * painel inteiro sem nunca virar um bug reproduzível.
 *
 * O gateway cobra do comprador o produto, mais o frete, mais o juro do
 * parcelamento, e manda a soma em `gross_cents`. Se o frete vai inteiro para
 * o transportador, ele não é receita: entra e sai no mesmo dia, e contá-lo
 * infla o faturamento e o ROAS junto. Quem embute o frete no preço do produto,
 * por outro lado, faturou aquilo de verdade.
 *
 * Não há resposta universal, e é por isso que a escolha é da loja.
 */

import { sql, type SQL } from "drizzle-orm";
import { orders } from "../db/schema";

export interface RegraFaturamento {
  countShipping: boolean;
  countInterest: boolean;
}

/** Como as consultas do painel devem ler o valor de uma venda. */
export function valorDaVenda(regra: RegraFaturamento): SQL<number> {
  /*
   * `coalesce` em tudo que subtrai: frete e juro são colunas anuláveis, e
   * `10000 - NULL` em SQL é NULL, não 10000. Sem isso, uma venda sem frete
   * informado zeraria o faturamento dela inteiro em vez de somar normalmente.
   */
  const descontos: SQL[] = [];
  if (!regra.countShipping) descontos.push(sql`coalesce(${orders.shippingCents}, 0)`);
  if (!regra.countInterest) descontos.push(sql`coalesce(${orders.interestCents}, 0)`);

  if (descontos.length === 0) return sql<number>`${orders.grossCents}`;

  return sql<number>`(${orders.grossCents} - ${sql.join(descontos, sql` - `)})`;
}

/*
 * A mesma regra, para consultas escritas em SQL cru.
 *
 * `valorDaVenda` monta a expressão a partir das colunas do Drizzle e só serve
 * onde a consulta também é do Drizzle. As agregações do resumo são SQL escrito
 * à mão — precisam da versão com nome de coluna, e do apelido da tabela quando
 * a consulta tem junção.
 */
export function valorCru(regra: RegraFaturamento, apelido?: string): SQL<number> {
  const p = apelido ? `${apelido}.` : "";
  const descontos: string[] = [];
  if (!regra.countShipping) descontos.push(`coalesce(${p}shipping_cents, 0)`);
  if (!regra.countInterest) descontos.push(`coalesce(${p}interest_cents, 0)`);

  const texto = descontos.length === 0
    ? `${p}gross_cents`
    : `(${p}gross_cents - ${descontos.join(" - ")})`;

  return sql.raw(texto) as SQL<number>;
}

/** A mesma regra, para quando o valor já está em memória. */
export function valorEmMemoria(
  venda: { grossCents: number; shippingCents?: number | null; interestCents?: number | null },
  regra: RegraFaturamento,
): number {
  let v = venda.grossCents;
  if (!regra.countShipping) v -= venda.shippingCents ?? 0;
  if (!regra.countInterest) v -= venda.interestCents ?? 0;
  return v;
}

/** Padrão de quem ainda não escolheu: conta tudo, que é o que o gateway informa. */
export const REGRA_PADRAO: RegraFaturamento = { countShipping: true, countInterest: true };

/**
 * Descreve a regra em uma linha, para a tela poder dizer o que está somando.
 * Um número de faturamento sem esta legenda é um número que ninguém consegue
 * conferir contra o extrato do gateway.
 */
export function descreverRegra(regra: RegraFaturamento): string {
  const fora: string[] = [];
  if (!regra.countShipping) fora.push("frete");
  if (!regra.countInterest) fora.push("juros");
  if (fora.length === 0) return "inclui frete e juros";
  return `sem ${fora.join(" nem ")}`;
}
