/*
 * A taxa do gateway.
 *
 * O que se testa aqui é a diferença entre "não cobrou" e "não sei" — porque
 * ela vira lucro na tela. Zero afirma que o gateway ficou com nada; nulo
 * admite ignorância e deixa o painel avisar. Confundir os dois infla o lucro
 * de toda venda de gateway que não informa taxa, que é a maioria.
 */
const { calcularTaxa, tabelaConfigurada, TABELA_VAZIA } = require("../_tmp/core/taxas.js");

let f = 0;
const eq = (l, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) f++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${l}` + (ok ? "" : `  obtido ${JSON.stringify(g)}, esperado ${JSON.stringify(w)}`)); };

const TABELA = {
  pix: { percentual: 0.99, fixoCents: 0 },
  boleto: { percentual: 0, fixoCents: 349 },
  credit_card: [
    { ateParcelas: 1, percentual: 3.99, fixoCents: 49 },
    { ateParcelas: 6, percentual: 4.99, fixoCents: 49 },
    { ateParcelas: 12, percentual: 5.99, fixoCents: 49 },
  ],
};

const venda = (grossCents, paymentMethod, installments) => ({ grossCents, paymentMethod, installments });

console.log("\n== pix ==");
/* R$ 100,00 a 0,99% = R$ 0,99 */
eq("percentual simples", calcularTaxa(venda(10000, "pix"), TABELA), 99);
eq("arredonda para o centavo", calcularTaxa(venda(9999, "pix"), TABELA), 99);
eq("venda de zero não gera taxa", calcularTaxa(venda(0, "pix"), TABELA), 0);

console.log("\n== boleto: só parte fixa ==");
eq("R$ 3,49 fixos", calcularTaxa(venda(10000, "boleto"), TABELA), 349);
eq("não varia com o valor", calcularTaxa(venda(50000, "boleto"), TABELA), 349);

console.log("\n== cartão, por faixa ==");
/* R$ 100,00 à vista: 3,99% + R$ 0,49 = R$ 4,48 */
eq("à vista", calcularTaxa(venda(10000, "credit_card", 1), TABELA), 448);
/* 3x cai na faixa de até 6: 4,99% + 0,49 = R$ 5,48 */
eq("3x usa a faixa de até 6", calcularTaxa(venda(10000, "credit_card", 3), TABELA), 548);
eq("6x ainda é a mesma faixa", calcularTaxa(venda(10000, "credit_card", 6), TABELA), 548);
/* 7x sobe: 5,99% + 0,49 = R$ 6,48 */
eq("7x sobe de faixa", calcularTaxa(venda(10000, "credit_card", 7), TABELA), 648);
eq("12x é o topo", calcularTaxa(venda(10000, "credit_card", 12), TABELA), 648);

/*
 * Acima do teto cadastrado, vale a última faixa. A alternativa seria devolver
 * nulo — mas 18x num gateway configurado até 12 é parcelamento novo, não
 * método desconhecido, e cobrar a maior faixa erra menos que não cobrar nada.
 */
eq("18x cai na última faixa", calcularTaxa(venda(10000, "credit_card", 18), TABELA), 648);

console.log("\n== sem parcelas informadas ==");
/* Sem `installments`, assume à vista: é o caso de pix virando cartão 1x. */
eq("assume à vista", calcularTaxa(venda(10000, "credit_card"), TABELA), 448);
eq("null vira à vista", calcularTaxa(venda(10000, "credit_card", null), TABELA), 448);

console.log("\n== não sei é diferente de não cobrou ==");
eq("tabela vazia devolve null", calcularTaxa(venda(10000, "pix"), TABELA_VAZIA), null);
eq("método sem regra devolve null", calcularTaxa(venda(10000, "debit_card"), TABELA), null);
eq("cartão sem faixas devolve null", calcularTaxa(venda(10000, "credit_card", 1), { pix: TABELA.pix }), null);

console.log("\n== rede de segurança: outros ==");
const COM_OUTROS = { ...TABELA, outros: { percentual: 2, fixoCents: 10 } };
eq("método desconhecido cai em outros", calcularTaxa(venda(10000, "wallet"), COM_OUTROS), 210);
eq("debito sem regra própria cai em outros", calcularTaxa(venda(10000, "debit_card"), COM_OUTROS), 210);
eq("mas pix continua usando a dele", calcularTaxa(venda(10000, "pix"), COM_OUTROS), 99);

console.log("\n== erro de cadastro não vira número absurdo ==");
/*
 * 399 no lugar de 3,99 é o erro clássico de vírgula. A API recusa antes de
 * gravar, mas se escapar por outro caminho o cálculo não pode devolver taxa
 * maior que a venda — isso viraria faturamento líquido negativo no painel.
 */
eq("taxa nunca passa do valor da venda",
  calcularTaxa(venda(10000, "pix"), { pix: { percentual: 399, fixoCents: 0 } }), 10000);
eq("percentual negativo não devolve crédito",
  calcularTaxa(venda(10000, "pix"), { pix: { percentual: -5, fixoCents: 0 } }), 0);

console.log("\n== a tabela está configurada? ==");
eq("vazia não está", tabelaConfigurada(TABELA_VAZIA), false);
eq("nula não está", tabelaConfigurada(null), false);
eq("com pix está", tabelaConfigurada({ pix: TABELA.pix }), true);
eq("com faixas de cartão está", tabelaConfigurada({ credit_card: TABELA.credit_card }), true);
eq("cartão com lista vazia não está", tabelaConfigurada({ credit_card: [] }), false);

console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
process.exit(f === 0 ? 0 : 1);
