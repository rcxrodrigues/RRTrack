/*
 * Quantas casas decimais cada moeda tem — e como converter para a unidade que
 * guardamos.
 *
 * Está fora de ui/moeda.tsx porque não é assunto de tela. Quem lê "129.95" de
 * um webhook da Shopify e quem escreve "R$ 129,95" no painel precisam usar
 * exatamente a mesma regra; se uma das duas mudar sozinha, o número entra por
 * uma porta e sai diferente pela outra, sem erro nenhum no caminho.
 *
 * O sistema inteiro guarda dinheiro como inteiro na MENOR unidade da moeda.
 * "Centavos" é o nome que a gente usa, mas nem toda moeda tem centavo: iene e
 * guarani não têm subdivisão, e ¥1000 são mil unidades menores, não cem mil.
 */

/**
 * Casas decimais da moeda. Duas para quase todas, zero para iene e guarani.
 *
 * A resposta vem do `Intl`, e não de uma lista escrita à mão, porque a lista
 * ficaria desatualizada em silêncio — e o sintoma seria um valor cem vezes
 * errado numa moeda que ninguém testou.
 */
export function casasDecimais(moeda: string): number {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: (moeda || "BRL").toUpperCase(),
    }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    /* Código de moeda que o Intl não conhece: duas casas é o caso comum. */
    return 2;
  }
}

/**
 * Converte um valor escrito em unidades da moeda para a menor unidade dela.
 *
 *   paraMenorUnidade("129.95", "BRL")  → 12995
 *   paraMenorUnidade("1000",   "JPY")  → 1000
 *
 * É para quem recebe DECIMAL — Shopify, Stripe em alguns campos, planilha do
 * lojista. Não use para gateway que já manda a menor unidade: aqui "12995"
 * viraria 1.299.500, porque esta função acredita no que recebe.
 */
export function paraMenorUnidade(valor: unknown, moeda: string): number {
  const n = typeof valor === "number" ? valor
    : typeof valor === "string" ? parseFloat(valor.trim())
    : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10 ** casasDecimais(moeda));
}
