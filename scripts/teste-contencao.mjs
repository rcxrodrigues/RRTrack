/*
 * A contenção dos endpoints públicos.
 *
 * Roda pela suíte: `node scripts/testar.mjs` compila os módulos em _tmp antes.
 *
 * O QUE ESTÁ EM JOGO, e é o contrário do que parece. O risco maior aqui não é
 * deixar passar um abuso — é BARRAR quem não devia. Beacon barrado é atribuição
 * perdida em silêncio: o evento não chega, nada dá erro, e a venda aparece como
 * tráfego direto semanas depois. Webhook barrado é pior ainda: é venda que não
 * entra.
 *
 * Por isso a maior parte das asserções abaixo é sobre o que a contenção
 * DEIXA passar, e sobre falhar aberto.
 */

import { readFileSync } from "node:fs";

const {
  janelaDe, fimDaJanela, chaveDe, estourou, respostaDeEstouro, cabeNoLimite,
  CORPO_MAXIMO, TETOS,
} = await import("../_tmp/core/contencao.js");

let f = 0;
const eq = (l, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) f++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${l}` + (ok ? "" : `\n         obtido:   ${JSON.stringify(g)}\n         esperado: ${JSON.stringify(w)}`)); };

const ler = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

/* ------------------------------------------------------------ a janela -- */

console.log("\n== a janela, que é o relógio da contagem ==");

/*
 * Um instante que CAI na virada do minuto, de propósito.
 *
 * Com um instante qualquer a conta do `Retry-After` depende de quanto do
 * minuto já passou, e quem lê o teste precisa fazer aritmética para saber se
 * o número esperado está certo. Alinhado, "15 s depois faltam 45" se confere
 * de cabeça — e teste cuja expectativa ninguém confere é teste que se ajusta
 * ao código em vez de vigiá-lo.
 */
const T0 = 28_333_334 * 60 * 1000; /* 1.700.000.040.000 */

eq("o mesmo segundo cai na mesma janela",
  janelaDe(T0, 60), janelaDe(T0 + 999, 60));
eq("um minuto depois é outra janela",
  janelaDe(T0 + 60_000, 60) - janelaDe(T0, 60), 1);
eq("e a janela avança de um em um",
  janelaDe(T0 + 600_000, 60) - janelaDe(T0, 60), 10);

/*
 * A virada tem de ser EXATA. Se `fimDaJanela` devolvesse um instante dentro da
 * janela atual, o `Retry-After` mandaria o gateway voltar cedo demais — ele
 * levaria 429 de novo, e a cada rodada a venda demoraria mais para entrar.
 */
eq("a virada cai no início da janela seguinte",
  janelaDe(fimDaJanela(T0, 60), 60), janelaDe(T0, 60) + 1);
eq("e nunca no passado", fimDaJanela(T0, 60) > T0, true);

console.log("\n  -- e a janela entra na CHAVE, não numa coluna --");
/*
 * Assim cada janela é uma linha nova e a anterior morre por validade. Zerar
 * contador seria uma escrita a mais, no caminho mais quente, para chegar ao
 * mesmo lugar.
 */
eq("mesma janela, mesma chave",
  chaveDe("collect:ip", "1.2.3.4", T0, 60), chaveDe("collect:ip", "1.2.3.4", T0 + 999, 60));
eq("janela nova, chave nova",
  chaveDe("collect:ip", "1.2.3.4", T0, 60) === chaveDe("collect:ip", "1.2.3.4", T0 + 60_000, 60),
  false);
/* Sem o escopo, o teto da coleta e o do webhook somariam no mesmo balde. */
eq("escopos diferentes não se misturam",
  chaveDe("collect:ip", "1.2.3.4", T0, 60) === chaveDe("webhook:ip", "1.2.3.4", T0, 60),
  false);
eq("e quem diferente também não",
  chaveDe("collect:ip", "1.2.3.4", T0, 60) === chaveDe("collect:ip", "1.2.3.5", T0, 60),
  false);

/* ------------------------------------------------------------- o teto -- */

console.log("\n== o teto, e de que lado ele erra ==");

eq("abaixo do teto passa", estourou(1, 600), false);
eq("no teto ainda passa", estourou(600, 600), false);
eq("um acima estoura", estourou(601, 600), true);

/*
 * ESTA É A ASSERÇÃO QUE PROTEGE O CLIENTE. `undefined` é o upsert não ter
 * devolvido linha — coisa que não deveria acontecer, e que se acontecer é
 * defeito NOSSO. Barrar aí transformaria um defeito nosso em coleta perdida
 * dele, que é exatamente a troca que não se quer fazer.
 */
eq("contagem ausente PASSA, em vez de barrar", estourou(undefined, 600), false);

console.log("\n  -- e os tetos são folgados de propósito --");
/*
 * Um navegador manda um page_view por página, um pulso por minuto e um punhado
 * de eventos por clique. Teto baixo barraria escritório atrás de um IP só.
 */
eq("coleta por IP, por minuto", TETOS.coletaPorIp.teto >= 300, true);
eq("coleta por loja, bem maior que por IP",
  TETOS.coletaPorLoja.teto > TETOS.coletaPorIp.teto, true);
/* Gateway manda em rajada quando reentrega fila acumulada. */
eq("webhook por conexão, generoso", TETOS.webhookPorConexao.teto >= 300, true);
eq("todas as janelas são de um minuto",
  Object.values(TETOS).every((t) => t.segundos === 60), true);

/* ------------------------------------------------------- a resposta -- */

console.log("\n== 429, e não 403 ==");
/*
 * 403 diz "você não tem permissão", que convida a investigar credencial. 429
 * diz "volte depois", que é a verdade — e é o único código que um gateway
 * trata como transitório e REENTREGA. Um 4xx permanente num webhook faria ele
 * desistir, e a venda sumiria sem erro nenhum do lado de cá.
 */
const r = respostaDeEstouro(T0 + 15_000, 60);
eq("o código é 429", r.status, 429);
eq("e vem com Retry-After", r.headers.get("retry-after") !== null, true);

/*
 * O Retry-After tem de apontar para DEPOIS da virada. Apontando para antes, o
 * gateway volta cedo, leva 429 de novo, e a venda demora mais a cada rodada.
 */
const esperar = Number(r.headers.get("retry-after"));
eq("espera até a virada", esperar, 45);
eq("nunca zero — zero é laço apertado", Number(respostaDeEstouro(T0 + 59_999, 60).headers.get("retry-after")) >= 1, true);

console.log("\n  -- e os cabeçalhos de CORS sobrevivem ao 429 --");
/*
 * Sem eles o navegador nem deixa o JavaScript ver a resposta: o 429 vira um
 * erro de rede genérico no console da loja, e quem for diagnosticar não
 * encontra nada dizendo "contenção".
 */
const comCors = respostaDeEstouro(T0, 60, { "access-control-allow-origin": "https://loja.com.br" });
eq("a origem continua ecoada",
  comCors.headers.get("access-control-allow-origin"), "https://loja.com.br");
eq("e o retry-after entrou junto", comCors.headers.get("retry-after") !== null, true);

/* ------------------------------------------------------ o corpo -- */

console.log("\n== o teto de corpo ==");
/*
 * `webhook_deliveries.raw_body` guarda o corpo inteiro e não tem retenção: um
 * POST de 50 MB não é um pico, é 50 MB no banco para sempre.
 */
eq("beacon normal cabe", cabeNoLimite("1200"), true);
eq("sem content-length, passa nesta etapa", cabeNoLimite(null), true);
eq("content-length absurdo não cabe", cabeNoLimite(String(50 * 1024 * 1024)), false);
eq("no limite exato cabe", cabeNoLimite(String(CORPO_MAXIMO)), true);
eq("um byte acima não", cabeNoLimite(String(CORPO_MAXIMO + 1)), false);
/* Cabeçalho mentiroso não abre a porta: o tamanho real é conferido depois. */
eq("content-length pequeno mas corpo grande não passa",
  cabeNoLimite("10", CORPO_MAXIMO + 1), false);
eq("lixo no cabeçalho não derruba", cabeNoLimite("nao-e-numero"), true);
/* Folgado: nenhum beacon legítimo chega perto de 256 kB. */
eq("o teto é bem maior que um beacon cheio", CORPO_MAXIMO > 100_000, true);

/* -------------------------------------------- o que só dá para ler -- */

console.log("\n== falha ABERTO nos dois endpoints ==");
/*
 * Isto não roda aqui (precisa de banco), então fica como leitura do código —
 * e é a propriedade mais importante das duas rotas. Contenção que derruba
 * coleta protege o banco e perde a venda: a troca errada.
 */
const coletor = ler("app/api/collect/route.ts");
const receber = ler("src/core/receber.ts");

eq("o coletor cai na busca sozinha quando a contenção quebra",
  /catch \(e\) \{[\s\S]{0,400}?contenção indisponível[\s\S]{0,300}?db\.select\(\)\.from\(sites\)/.test(coletor),
  true);
eq("e o webhook segue adiante quando ela quebra",
  /catch \(e\) \{[\s\S]{0,300}?\[receber\] contenção indisponível/.test(receber), true);

console.log("\n  -- e a contagem não custa uma ida a mais ao banco --");
/*
 * `db.batch()` manda tudo num pedido HTTP só. (`db.transaction()` não serve:
 * o driver HTTP do Neon lança "No transactions support" nele.)
 */
eq("o coletor conta junto da busca do site",
  /db\.batch\(\[\s*\n\s*contar\(\{ \.\.\.TETOS\.coletaPorIp/.test(coletor), true);

console.log("\n  -- e a chave de site é conferida ANTES de virar linha --");
/*
 * A contenção conta POR chave de site, e a chave vem do pedido. Sem o corte de
 * formato, quem mandasse uma chave inventada diferente a cada requisição
 * criaria uma linha nova em `rate_limits` por chamada — a contenção viraria o
 * vetor que ela existe para fechar.
 */
eq("o formato da chave é exigido", /\^pk_\[A-Za-z0-9_\]\{4,64\}\$/.test(coletor), true);
/* E o corte vem antes do batch, senão não adianta nada. */
eq("e o corte vem antes de tocar no banco",
  coletor.indexOf("^pk_[A-Za-z0-9_]{4,64}$") < coletor.indexOf("db.batch(["), true);

console.log("\n== a ordem dos cabeçalhos de IP mora num lugar só ==");
/*
 * Vivia copiada no coletor e no login. A contenção precisaria de uma terceira
 * cópia — e cópia que diverge é o defeito mais caro deste repositório. Contar
 * a borda do proxy somaria o mundo inteiro num balde só, e o teto de abuso
 * barraria comprador de verdade.
 */
const ip = ler("src/core/ip.ts");
/*
 * Compara a ordem das LEITURAS, não a das menções: o comentário do arquivo
 * cita `x-forwarded-for` antes, ao explicar o defeito, e procurar pelo nome
 * solto media o texto em vez do código.
 */
const ordemDeLeitura = [...ip.matchAll(/req\.headers\.get\("([a-z-]+)"\)/g)].map((m) => m[1]);
eq("a Cloudflare é a primeira lida", ordemDeLeitura[0], "cf-connecting-ip");
eq("e o x-forwarded-for vem depois dela",
  ordemDeLeitura.indexOf("x-forwarded-for") > 0, true);
for (const arq of ["app/api/collect/route.ts", "src/core/receber.ts", "app/api/auth/entrar/route.ts"]) {
  eq(`${arq} usa o de core/ip.ts`, ler(arq).includes("ipDoCliente"), true);
  eq(`  e não tem cópia própria`, ler(arq).includes('"cf-connecting-ip"'), false);
}

console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
process.exit(f === 0 ? 0 : 1);
