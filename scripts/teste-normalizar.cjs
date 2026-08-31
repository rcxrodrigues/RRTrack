/*
 * As duas armadilhas que todo adaptador de gateway cai.
 *
 * Não são hipóteses: as duas já custaram dado neste projeto. A pagou.ai manda
 * `"phone": "null"` — a palavra — e o Appmax manda data sem fuso, que o
 * JavaScript lê como hora do servidor.
 *
 *   node scripts/teste-normalizar.cjs
 */
const { texto, instante } = require("../_tmp/core/normalizar.js");

let f = 0;
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) f++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${l}` + (ok ? "" : `  obtido ${JSON.stringify(got)}, esperado ${JSON.stringify(want)}`));
};

console.log("\n== nulo escrito como texto nao e valor ==");
for (const v of ["null", "NULL", " null ", "undefined", "nil", "none", "N/A", "-", ""]) {
  eq(`"${v}" e ausencia`, texto(v), undefined);
}
eq("texto de verdade passa", texto(" Ana "), "Ana");
/* Numero vira texto: id de pedido chega como numero em varios gateways. */
eq("numero vira texto", texto(530000001), "530000001");
eq("zero nao e ausencia", texto(0), "0");
/* "nulo" em portugues NAO entra na lista: e nome de gente em alguns lugares
   e a chance de falso positivo nao compensa. */
eq("palavra portuguesa nao e filtrada", texto("nulo"), "nulo");

console.log("\n== data sem fuso: o pressuposto e declarado ==");
/* Sao Paulo e UTC-3, entao 14:30 de Brasilia sao 17:30 em UTC. */
eq("sem fuso, assumindo Brasilia",
  instante("2026-08-22 14:30:00", "America/Sao_Paulo").toISOString(), "2026-08-22T17:30:00.000Z");
eq("sem fuso, assumindo UTC",
  instante("2026-08-22 14:30:00", "UTC").toISOString(), "2026-08-22T14:30:00.000Z");
/* As duas leituras diferem em tres horas: e por isso que o pressuposto
   precisa ser escolhido, e nao herdado do fuso do servidor. */
eq("com T, mas ainda sem fuso, vale o mesmo",
  instante("2026-08-22T14:30:00", "America/Sao_Paulo").toISOString(), "2026-08-22T17:30:00.000Z");

console.log("\n== fuso escrito sempre vence o pressuposto ==");
eq("Z e respeitado",
  instante("2026-08-22T14:30:00Z", "America/Sao_Paulo").toISOString(), "2026-08-22T14:30:00.000Z");
eq("deslocamento escrito e respeitado",
  instante("2026-08-22T14:30:00-03:00", "UTC").toISOString(), "2026-08-22T17:30:00.000Z");

console.log("\n== a borda do dia, que e onde isso morde ==");
/* 23:30 de Brasilia ja e o dia seguinte em UTC. Ler errado move a venda de
   dia, e o faturamento fecha diferente do extrato sem motivo aparente. */
eq("23:30 em Brasilia vira 02:30 UTC do dia seguinte",
  instante("2026-08-22 23:30:00", "America/Sao_Paulo").toISOString(), "2026-08-23T02:30:00.000Z");

console.log("\n== lixo nao vira data ==");
eq("texto qualquer", instante("nao e data", "UTC"), undefined);
eq("vazio", instante("", "UTC"), undefined);
eq('"null" tambem aqui', instante("null", "UTC"), undefined);

console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
process.exit(f === 0 ? 0 : 1);
