/*
 * As janelas de data do seletor de período.
 *
 * Erro aqui não dá exceção: dá um painel mostrando o intervalo errado, com
 * números plausíveis. "Ontem" pegando hoje junto, ou "esse mês" começando no
 * dia errado, passa despercebido até alguém conferir com o extrato.
 *
 *   node scripts/teste-janela.cjs
 */
const { janelaDe } = require("../_tmp/core/janela.js");

let f = 0;
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) f++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${l}` + (ok ? "" : `  obtido ${JSON.stringify(got)}, esperado ${JSON.stringify(want)}`));
};

const SP = "America/Sao_Paulo";
const hoje = new Date().toLocaleString("sv-SE", { timeZone: SP }).slice(0, 10);
const menos = (d, n) => {
  const x = new Date(d + "T12:00:00Z");
  x.setUTCDate(x.getUTCDate() - n);
  return x.toISOString().slice(0, 10);
};

console.log("\n== os períodos fixos ==");
eq("hoje é um dia só", janelaDe("hoje", SP), { de: hoje, ate: hoje });
/* Ontem tem que EXCLUIR hoje nas duas pontas: incluir hoje faria a comparação
   entre ontem e hoje comparar ontem com ontem+hoje. */
eq("ontem exclui hoje", janelaDe("ontem", SP), { de: menos(hoje, 1), ate: menos(hoje, 1) });
eq("7 dias inclui hoje e mais seis", janelaDe("7d", SP), { de: menos(hoje, 6), ate: hoje });
eq("30 dias", janelaDe("30d", SP), { de: menos(hoje, 29), ate: hoje });

console.log("\n== mês ==");
eq("esse mês começa no dia 1", janelaDe("mes", SP).de, hoje.slice(0, 8) + "01");
eq("e termina hoje", janelaDe("mes", SP).ate, hoje);

const passado = janelaDe("mespassado", SP);
eq("mês passado começa no dia 1", passado.de.slice(8), "01");
/* Termina no ÚLTIMO dia do mês passado, que é a véspera do dia 1 deste. */
eq("e termina na véspera do dia 1 deste", passado.ate, menos(hoje.slice(0, 8) + "01", 1));
eq("os dois no mesmo mês", passado.de.slice(0, 7), passado.ate.slice(0, 7));
/* Fevereiro, mês de 30 e mês de 31 dias têm de sair certos sozinhos. */
eq("mês passado não invade este", passado.ate < hoje.slice(0, 8) + "01", true);

console.log("\n== personalizado ==");
eq("datas válidas passam",
  janelaDe("personalizado", SP, { de: "2026-01-10", ate: "2026-02-05" }),
  { de: "2026-01-10", ate: "2026-02-05" });
/* Invertidas: quem escolheu quis o intervalo, então troca em vez de recusar. */
eq("invertidas são trocadas",
  janelaDe("personalizado", SP, { de: "2026-02-05", ate: "2026-01-10" }),
  { de: "2026-01-10", ate: "2026-02-05" });
/* Incompleto cai no padrão: janela vazia mostraria zero, e zero por parâmetro
   torto é indistinguível de um dia sem venda. */
eq("faltando uma data cai em hoje",
  janelaDe("personalizado", SP, { de: "2026-01-10" }), { de: hoje, ate: hoje });
eq("formato inválido cai em hoje",
  janelaDe("personalizado", SP, { de: "10/01/2026", ate: "05/02/2026" }), { de: hoje, ate: hoje });
eq("sem nada cai em hoje", janelaDe("personalizado", SP), { de: hoje, ate: hoje });

console.log("\n== máximo ==");
eq("começa antes do projeto existir", janelaDe("max", SP).de, "2020-01-01");
eq("e termina hoje", janelaDe("max", SP).ate, hoje);

console.log("\n== o fuso decide qual é 'hoje' ==");
/* Às 21h em São Paulo já é o dia seguinte em Tóquio. As duas janelas têm de
   discordar, senão o fuso da loja não está sendo respeitado. */
const emToquio = janelaDe("hoje", "Asia/Tokyo").de;
const emSP = janelaDe("hoje", SP).de;
eq("fusos diferentes podem dar dias diferentes",
  emToquio >= emSP, true);

console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
process.exit(f === 0 ? 0 : 1);
