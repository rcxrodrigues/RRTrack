/*
 * A retenção de log.
 *
 * Roda pela suíte: `node scripts/testar.mjs` compila os módulos em _tmp antes.
 *
 * O QUE ESTÁ EM JOGO. Três colunas guardam o corpo inteiro do que passou e
 * nunca eram limpas — o banco cresce até encostar no limite do plano, que é um
 * dia ruim para descobrir. Só que limpar demais é pior que não limpar:
 *
 *   `dispatches.request_body` é O QUE A FILA DE REENVIO REENVIA. Zerar um
 *   disparo que ainda está na fila faz `reenviarPendentes` desistir com "sem
 *   payload guardado para reenviar" — conversão perdida, em silêncio, por
 *   causa da faxina.
 *
 *   `webhook_deliveries.raw_body` é NOT NULL. Um UPDATE para NULL ali não
 *   limpa nada: estoura a restrição e derruba a rotina inteira.
 *
 * Como as três varreduras precisam de banco, o que se prova aqui é o SQL que
 * elas montam e a lógica de parada. O resto está no comentário do módulo.
 */

import { readFileSync } from "node:fs";

const {
  corteDe, acabouOTempo, DIAS_PADRAO, LOTE_PADRAO, TETO_MS_PADRAO,
} = await import("../_tmp/core/retencao.js");

let f = 0;
const eq = (l, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) f++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${l}` + (ok ? "" : `\n         obtido:   ${JSON.stringify(g)}\n         esperado: ${JSON.stringify(w)}`)); };

const ler = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const fonte = ler("src/core/retencao.ts");

/* ------------------------------------------------------------- o corte -- */

console.log("\n== o corte ==");

const AGORA = new Date("2026-09-19T12:00:00.000Z");
eq("catorze dias atrás", corteDe(AGORA, 14).toISOString(), "2026-09-05T12:00:00.000Z");
eq("o padrão são catorze dias", DIAS_PADRAO, 14);
/* Corte no futuro apagaria o de hoje — o zero tem de ser o próprio instante. */
eq("zero dias é agora, não amanhã", corteDe(AGORA, 0).getTime(), AGORA.getTime());

/* ------------------------------------------------------------ a parada -- */

console.log("\n== quando parar ==");
/*
 * Errar isto nos dois sentidos custa: parar cedo demais faz a limpeza nunca
 * alcançar o acúmulo; parar tarde demais é a função morrer no meio, e aí o log
 * mostra só um timeout, sem dizer quanto faltou.
 */
eq("no começo, continua", acabouOTempo(1000, 45_000, 1000), false);
eq("perto do teto, continua", acabouOTempo(1000, 45_000, 45_000), false);
eq("no teto exato, para", acabouOTempo(1000, 45_000, 46_000), true);
eq("passado do teto, para", acabouOTempo(1000, 45_000, 99_000), true);

/* O limite da função na Vercel é de 60 s no plano básico; parar antes é o ponto. */
eq("o teto fica abaixo de 60 s", TETO_MS_PADRAO < 60_000, true);
/* Lote grande trava a tabela; pequeno demais gasta ida e volta à toa. */
eq("o lote é modesto", LOTE_PADRAO <= 5000 && LOTE_PADRAO >= 100, true);

/* ------------------------------------------------- o que NÃO pode sair -- */

console.log("\n== a fila de reenvio é intocável ==");
/*
 * ESTA É A ASSERÇÃO MAIS IMPORTANTE DO ARQUIVO. Disparo com `next_attempt_at`
 * marcado está na fila, e o reenvio reconstrói o pedido a partir do
 * `request_body` guardado — é para isso que ele existe. Zerar ali mata a
 * conversão sem nada acusando.
 */
/*
 * O comando é RECORTADO antes de ser conferido, e não é preciosismo.
 *
 * A primeira versão desta asserção procurava "next_attempt_at IS NULL" no
 * arquivo inteiro — e a frase aparece TAMBÉM em `corpoVelhoParado`, lá
 * embaixo. Apagar a guarda do UPDATE não reprovava nada: a busca achava a
 * outra ocorrência e dizia que estava tudo bem. Guarda que não vigia é pior
 * que guarda nenhuma, porque dá sossego.
 */
const comando = (inicio) => {
  const m = new RegExp(inicio + "[\\s\\S]*?LIMIT \\$\\{lote\\}").exec(fonte);
  return m ? m[0] : "";
};
const updateDisparos = comando("UPDATE dispatches");
eq("o comando de disparos foi encontrado", updateDisparos.length > 0, true);
eq("e exige next_attempt_at IS NULL",
  updateDisparos.includes("next_attempt_at IS NULL"), true);
/* E o reenvio realmente depende disso — a outra ponta da mesma corda. */
eq("e o reenvio de fato desiste sem payload",
  ler("src/core/dispatch.ts").includes("sem payload guardado para reenviar"), true);

console.log("\n  -- e a linha FICA, só o corpo sai --");
/*
 * Data, evento, status, chaves de correspondência e tenant são o que o painel
 * lê e o que responde "essa venda foi enviada?" seis meses depois. Apagar a
 * linha responderia "não foi", que é diferente e mentira.
 */
eq("disparos: UPDATE, nunca DELETE",
  /DELETE FROM dispatches/.test(fonte), false);
eq("entregas: UPDATE, nunca DELETE",
  /DELETE FROM webhook_deliveries/.test(fonte), false);
/* A exceção: contador de contenção não é histórico de nada. */
eq("contadores de contenção, esses sim são apagados",
  /DELETE FROM rate_limits/.test(fonte), true);

console.log("\n  -- e raw_body vira string vazia, não NULL --");
/*
 * A coluna é NOT NULL. Um UPDATE para NULL não limpa nada: estoura a restrição
 * e derruba a rotina inteira, incluindo o que ela ainda ia limpar.
 */
eq("o schema exige raw_body",
  /rawBody: text\("raw_body"\)\.notNull\(\)/.test(ler("src/db/schema.ts")), true);
eq("e a retenção respeita isso", /raw_body = ''/.test(fonte), true);
eq("sem tentar NULL nela", /raw_body = NULL/.test(fonte), false);

console.log("\n  -- e a varredura encolhe, em vez de repetir o já limpo --");
/*
 * Sem o filtro pelo que ainda TEM corpo, cada execução varreria as mesmas
 * linhas já zeradas para sempre: a rotina pareceria funcionar, o tempo subiria
 * todo dia, e o acúmulo de verdade nunca seria alcançado.
 */
/* Recortados pelo mesmo motivo da asserção da fila: as duas frases também
   aparecem em `corpoVelhoParado`, e buscar no arquivo inteiro não vigiaria
   o comando que interessa. */
eq("disparos filtram pelo que ainda tem corpo",
  updateDisparos.includes("request_body IS NOT NULL OR response_body IS NOT NULL"), true);
eq("entregas também", comando("UPDATE webhook_deliveries").includes("raw_body <> ''"), true);

console.log("\n  -- e em lotes, com LIMIT --");
/* UPDATE em milhões de linhas de uma vez trava a tabela. */
eq("as três varreduras têm LIMIT",
  (fonte.match(/LIMIT \$\{lote\}/g) ?? []).length, 3);

/* ------------------------------------------------------------- a porta -- */

console.log("\n== a rota, e as duas portas fechadas ==");
const rota = ler("app/api/manutencao/retencao/route.ts");

/*
 * Sem CRON_SECRET no ambiente, a porta do cron NÃO EXISTE. Comparar contra uma
 * variável vazia deixaria "Bearer undefined" entrar — o mesmo defeito do `??`
 * que já pôs uma versão de API errada rodando em produção.
 */
eq("segredo vazio fecha a porta em vez de abri-la",
  /if \(!segredo\) return false;/.test(rota), true);
eq("e a comparação é em tempo constante",
  rota.includes("textoIgualEmTempoConstante"), true);
eq("ou uma sessão do painel", rota.includes("await contexto()"), true);

console.log("\n  -- e o cron está declarado --");
const vercel = JSON.parse(ler("vercel.json"));
eq("há um cron", Array.isArray(vercel.crons) && vercel.crons.length === 1, true);
eq("apontando para a rota", vercel.crons[0].path, "/api/manutencao/retencao");
/*
 * Minuto quebrado e madrugada: no topo da hora todo mundo agenda, e a fila da
 * Vercel atrasa. O horário é UTC — 4:17 UTC é 1:17 em Brasília, tráfego baixo.
 */
eq("de madrugada", /^\d+ [0-5] \* \* \*$/.test(vercel.crons[0].schedule), true);
eq("e fora do topo da hora", vercel.crons[0].schedule.startsWith("0 "), false);

console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
process.exit(f === 0 ? 0 : 1);
