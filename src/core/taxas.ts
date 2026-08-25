/*
 * Quanto o gateway fica de cada venda.
 *
 * Alguns informam a taxa no webhook — o pagou.ai manda `fee`. A maioria não
 * manda nada, e sem uma tabela cadastrada o painel mostra R$ 0,00 de taxa e
 * declara um lucro que não existe. Numa operação com 4% de taxa e 20% de
 * margem, ignorar a taxa erra o lucro em um quinto.
 *
 * A regra de precedência não muda: **taxa informada pelo gateway sempre
 * vence**. A tabela é estimativa do lojista; o webhook é o que foi cobrado de
 * verdade, com promoção, antecipação e negociação já dentro. Substituir o real
 * pelo estimado seria trocar dado por palpite.
 */

import type { PaymentMethod } from "./types";

export interface Taxa {
  /** Em pontos percentuais: 3.99 é 3,99%. */
  percentual: number;
  /** Parte fixa por transação, em centavos. */
  fixoCents: number;
}

/*
 * Cartão cobra por faixa de parcelamento — à vista é uma taxa, 2 a 6 é outra,
 * 7 a 12 é outra. As faixas são lidas em ordem e vale a primeira cujo teto
 * alcança o número de parcelas.
 */
export interface FaixaCartao extends Taxa {
  ateParcelas: number;
}

export interface TabelaTaxas {
  pix?: Taxa;
  boleto?: Taxa;
  debit_card?: Taxa;
  credit_card?: FaixaCartao[];
  /** Rede de segurança para método que a loja ainda não previu. */
  outros?: Taxa;
}

export const TABELA_VAZIA: TabelaTaxas = {};

/**
 * Aplica a tabela a uma venda.
 *
 * Devolve `null` quando não há regra para aquele método — e não zero. A
 * diferença importa: zero afirma que o gateway não cobrou nada, `null` admite
 * que não sabemos, e é o que permite a tela avisar em vez de mentir.
 */
export function calcularTaxa(
  venda: { grossCents: number; paymentMethod: PaymentMethod; installments?: number | null },
  tabela: TabelaTaxas,
): number | null {
  const regra = regraPara(venda.paymentMethod, venda.installments ?? 1, tabela);
  if (!regra) return null;

  /*
   * O percentual incide sobre o valor cheio que o comprador pagou, que é a
   * base que todo gateway usa — inclusive sobre o frete, quando ele foi
   * cobrado na mesma transação.
   */
  const bruto = Math.round(venda.grossCents * (regra.percentual / 100)) + regra.fixoCents;

  /* Taxa maior que a venda é erro de cadastro; cobrar mais que o total não
     acontece, e deixar passar produziria faturamento líquido negativo. */
  return Math.min(Math.max(bruto, 0), venda.grossCents);
}

function regraPara(
  metodo: PaymentMethod,
  parcelas: number,
  tabela: TabelaTaxas,
): Taxa | null {
  if (metodo === "credit_card") {
    const faixas = tabela.credit_card;
    if (!faixas?.length) return tabela.outros ?? null;
    const ordenadas = [...faixas].sort((a, b) => a.ateParcelas - b.ateParcelas);
    /* A última faixa cobre qualquer parcelamento acima do teto dela. */
    return ordenadas.find((f) => parcelas <= f.ateParcelas)
      ?? ordenadas[ordenadas.length - 1]
      ?? null;
  }

  if (metodo === "pix") return tabela.pix ?? tabela.outros ?? null;
  if (metodo === "boleto") return tabela.boleto ?? tabela.outros ?? null;
  if (metodo === "debit_card") return tabela.debit_card ?? tabela.outros ?? null;
  return tabela.outros ?? null;
}

/** A tabela tem alguma regra cadastrada? */
export function tabelaConfigurada(t: TabelaTaxas | null | undefined): boolean {
  if (!t) return false;
  return !!(t.pix || t.boleto || t.debit_card || t.outros || t.credit_card?.length);
}

/*
 * Ponto de partida para quem está cadastrando: as faixas que os gateways
 * brasileiros praticam com mais frequência. São chute informado, não verdade —
 * a tela deixa claro que é para conferir no extrato e corrigir.
 */
export const SUGESTAO: TabelaTaxas = {
  pix: { percentual: 0.99, fixoCents: 0 },
  credit_card: [
    { ateParcelas: 1, percentual: 3.99, fixoCents: 49 },
    { ateParcelas: 6, percentual: 4.99, fixoCents: 49 },
    { ateParcelas: 12, percentual: 5.99, fixoCents: 49 },
  ],
};
