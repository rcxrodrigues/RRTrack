/*
 * O coletor de primeira parte: o endereço do snippet e o cookie do clickId.
 *
 * Roda pela suíte: `node scripts/testar.mjs` compila os módulos em _tmp antes.
 *
 * POR QUE ISTO EXISTE. `sites.collector_host` era escrito em cinco lugares e
 * lido em zero. Consequência: o snippet apontava sempre para o domínio do
 * RRTrack, o `rr.js` era script de terceiro, e no Safari o `_rr_cid` — que é o
 * clickId, pensado para 90 dias — caía para 24 HORAS quando a pessoa chegava
 * por link com `?fbclid=`. Ou seja: em todo tráfego pago, no navegador padrão
 * do iPhone, a chave que liga a venda ao anúncio morria no dia seguinte, sem
 * erro em lugar nenhum.
 *
 * Consertar isso tem DUAS metades, e uma sem a outra não vale nada:
 *
 *   1. o snippet apontar para o subdomínio da loja;
 *   2. o coletor devolver o cookie por `Set-Cookie`, porque o limite do Safari
 *      é do cookie escrito por SCRIPT, não do script.
 *
 * Os testes abaixo cobrem as duas, mais a divergência entre as listas de
 * sufixo público que quase passou batido.
 */

import { readFileSync } from "node:fs";

let f = 0;
const eq = (l, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) f++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${l}` + (ok ? "" : `\n         obtido:   ${JSON.stringify(g)}\n         esperado: ${JSON.stringify(w)}`)); };

const ler = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

/* ------------------------------------------- as duas listas de sufixo -- */

console.log("\n== a lista de sufixo público é a MESMA nos dois lados ==");
/*
 * A lista está duplicada porque public/rr.js é servido estático ao navegador e
 * não importa de src/. Quando as duas divergiram, o servidor mandava
 * `Domain=.me.uk` — que o navegador recusa por ser sufixo público — e o cookie
 * não existia para aquelas lojas, calado. Esta comparação é o que impede a
 * divergência de voltar.
 */
const lista = (texto) => [...texto.matchAll(/"([a-z]{2,4}\.[a-z]{2,3})"/g)].map((m) => m[1]);

const doNavegador = lista(/var COMPOSTOS = \[(.*?)\];/s.exec(ler("public/rr.js"))[1]);
const doServidor = lista(
  /export const COMPOSTOS = new Set\(\[(.*?)\]\);/s.exec(ler("src/core/dominio.ts"))[1],
);

eq("o navegador conhece sufixos", doNavegador.length > 10, true);
eq("as duas listas batem", [...doServidor].sort(), [...doNavegador].sort());

/* ------------------------------------------------ domínio registrável -- */

/*
 * A função DE VERDADE, não uma cópia. A primeira versão deste teste
 * reimplementava a lógica aqui, e uma cópia que concorda consigo mesma não
 * prova nada sobre o que roda em produção.
 */
const { dominioDoSite, dominioRegistravel, mesmoSite, normalizarHost } =
  await import("../_tmp/core/dominio.js");

console.log("\n== domínio registrável ==");
eq("subdomínio simples", dominioRegistravel("www.loja.com"), "loja.com");
eq("sufixo composto leva três partes", dominioRegistravel("www.loja.com.br"), "loja.com.br");
eq("o coletor cai no mesmo domínio", dominioRegistravel("t.loja.com.br"), "loja.com.br");
eq("checkout em subdomínio também", dominioRegistravel("pay.loja.com.br"), "loja.com.br");
eq("já registrável passa igual", dominioRegistravel("loja.com.br"), "loja.com.br");
/* Se esta falhar, o cookie sai como Domain=.me.uk e o navegador recusa. */
eq("me.uk é sufixo, não domínio", dominioRegistravel("loja.me.uk"), "loja.me.uk");
eq("com.co idem", dominioRegistravel("loja.com.co"), "loja.com.co");

console.log("\n  -- e o valor SUJO que está no banco de produção --");
/*
 * `sites.domain` não tem um formato só. Convivem "florecomesticos.store" e
 * "https://transforlar.com/", a segunda com esquema e barra final porque
 * alguém colou a URL inteira no campo e nada reclamou.
 *
 * Custou duas falhas silenciosas: a verificação do coletor comparava
 * "https://transforlar.com/" com "transforlar.com" e RECUSAVA um subdomínio
 * legítimo; e o cookie saía `Domain=.transforlar.com/`, com barra, que o
 * navegador descarta sem avisar. Nenhuma das duas dá erro em lugar nenhum.
 */
eq("URL inteira vira domínio", dominioDoSite("https://transforlar.com/"), "transforlar.com");
eq("e o registrável também", dominioRegistravel("https://transforlar.com/"), "transforlar.com");
eq("o coletor bate com a URL suja", mesmoSite("track.transforlar.com", "https://transforlar.com/"), true);
eq("com caminho", dominioDoSite("https://loja.com.br/checkout?x=1"), "loja.com.br");
eq("com porta", dominioDoSite("http://loja.com.br:3000"), "loja.com.br");
eq("com www", dominioDoSite("https://www.loja.com.br/"), "loja.com.br");
eq("maiúscula", dominioDoSite("HTTPS://Loja.COM.BR"), "loja.com.br");
/* Nada de barra no domínio do cookie — é o defeito que isto impede de voltar. */
eq("nunca sobra barra", dominioRegistravel("https://transforlar.com/").includes("/"), false);

console.log("\n  -- e domínio reservado (RFC 2606) não é loja de verdade --");
/*
 * `orderBy(domain)` tornou a escolha do site ESTÁVEL, mas estável não é certo:
 * "qa-trocado.exemplo.com" vem antes de "transforlar.com" no alfabeto, então a
 * loja real ficava com a tela do site de teste. RFC 2606 reserva esses
 * domínios justamente para documentação e teste — desativá-los não é palpite.
 */
const fx = ler("scripts/faxina.mjs");
const listaRes = /const RESERVADOS = (\[[^\]]*\]);/.exec(fx)[1];
const corpoRes = /const reservado = \(d\) =>([\s\S]*?);\n/.exec(fx)[1];
const reservado = new Function("d", `const RESERVADOS = ${listaRes}; return (${corpoRes});`);
for (const [d, esperado] of [
  ["qa-trocado.exemplo.com", true], ["exemplo.com", true], ["example.com", true],
  ["algo.test", true], ["x.invalid", true],
  ["transforlar.com", false], ["florecomesticos.store", false],
  /* Estes dois são domínios de VERDADE e não podem cair na regra. */
  ["exemplo.com.br", false], ["meuexemplo.com", false],
]) {
  eq(`reservado(${d}) = ${esperado}`, reservado(d), esperado);
}

console.log("\n  -- e o painel AVISA quando há mais de um site ativo --");
/* Escolher em silêncio foi o que produziu a tela confusa. */
eq("a página busca todos os sites ativos, não limit(1)",
  /eq\(sites\.active, true\)\)\)\n\s*\.orderBy\(sites\.domain\),/
    .test(ler("app/(painel)/integracoes/page.tsx")), true);
eq("e a tela mostra quais são os outros",
  ler("src/ui/integracoes.tsx").includes("outrosSites.length + 1} sites ativos"), true);

console.log("\n  -- e a faxina nunca grava o apex como coletor --");
/*
 * "t.https://transforlar.com/" é o que estava gravado de verdade. O limpador
 * lê "t.https" como esquema e devolve "transforlar.com" — o domínio da loja.
 * Isso passava por "pertence ao domínio" e seria GRAVADO como coletor,
 * apontando o script para o Shopify da loja em vez do RRTrack.
 *
 * Coletor é SUBDOMÍNIO. Igual ao domínio não serve, e prefixo torto não tem
 * conserto automático — ninguém sabe se era "t." ou "track.".
 */
/*
 * A função DE VERDADE, extraída do script. A primeira versão desta guarda era
 * uma cópia, e quebrar a faxina de propósito não a reprovava — prova de que
 * ela não protegia nada.
 */
const serveComoColetor = new Function(
  "dominioDoSite", "guardado", "dominio",
  /function serveComoColetor\(guardado, dominio\) \{([\s\S]*?)\n\}/
    .exec(ler("scripts/faxina.mjs"))[1] + "\n",
).bind(null, dominioDoSite);
eq("o apex NÃO serve",
  serveComoColetor("t.https://transforlar.com/", "https://transforlar.com/"), false);
eq("subdomínio de verdade serve",
  serveComoColetor("https://track.transforlar.com/", "transforlar.com"), true);
eq("subdomínio de OUTRO domínio não serve",
  serveComoColetor("track.evil.com", "transforlar.com"), false);

console.log("\n  -- e a cópia de scripts/faxina.mjs concorda com a de produção --");
/*
 * A faxina é operação e não passa pelo build, então ela reimplementa
 * dominioDoSite. Cópia que diverge já nos custou tempo uma vez (as listas de
 * sufixo), e aqui a consequência seria pior: a faxina ESCREVE no banco. Uma
 * normalização diferente gravaria domínio que a produção lê de outro jeito.
 */
const faxina = ler("scripts/faxina.mjs");
const corpo = /function dominioDoSite\(guardado\) \{([\s\S]*?)\n\}/.exec(faxina)[1];
const daFaxina = new Function("guardado", corpo + "\n");
for (const caso of [
  "https://transforlar.com/", "florecomesticos.store", "www.loja.com.br",
  "HTTP://X.com:3000/a?b=1", "  Loja.COM.BR  ", "t.https://transforlar.com/",
]) {
  eq(`faxina e produção concordam em ${JSON.stringify(caso)}`,
    daFaxina(caso), dominioDoSite(caso));
}

console.log("\n  -- e recusa o que não é hostname --");
eq("vazio", normalizarHost("  "), null);
eq("sem ponto", normalizarHost("localhost"), null);
eq("ponto solto", normalizarHost("loja..com.br"), null);
eq("hostname bom passa", normalizarHost("  TRACK.Transforlar.com/  "), "track.transforlar.com");

/* --------------------------------------------- o endereço do snippet -- */

console.log("\n== o snippet aponta para o subdomínio quando há um ==");

/*
 * Reimplementa enderecoDoColetor. O original vive num .tsx com JSX, que a
 * suíte não compila para _tmp — e arrastar React para cá por três linhas de
 * lógica custaria mais do que a cópia.
 */
function enderecoDoColetor(site, base) {
  const c = site.coletor?.trim();
  if (!c || !site.coletorVerificadoEm) return base;
  return c.startsWith("http") ? c.replace(/\/$/, "") : `https://${c}`;
}

const BASE = "https://rr-track.vercel.app";
const OK = "2026-09-19T12:00:00.000Z";

eq("sem coletor, cai no domínio do RRTrack",
  enderecoDoColetor({ coletor: null, coletorVerificadoEm: OK }, BASE), BASE);
eq("vazio conta como ausente",
  enderecoDoColetor({ coletor: "   ", coletorVerificadoEm: OK }, BASE), BASE);
eq("hostname puro ganha esquema",
  enderecoDoColetor({ coletor: "t.loja.com.br", coletorVerificadoEm: OK }, BASE),
  "https://t.loja.com.br");
eq("URL inteira é respeitada",
  enderecoDoColetor({ coletor: "https://t.loja.com.br", coletorVerificadoEm: OK }, BASE),
  "https://t.loja.com.br");
eq("barra no fim é aparada",
  enderecoDoColetor({ coletor: "https://t.loja.com.br/", coletorVerificadoEm: OK }, BASE),
  "https://t.loja.com.br");

console.log("\n  -- e NÃO migra antes de alguém provar que o host responde --");
/*
 * Este é o teste que impede o pior defeito desta fase. `collector_host` é
 * preenchido sozinho no cadastro da loja, como palpite, muito antes de existir
 * DNS. Snippet apontando para host que não resolve não piora a coleta: mata a
 * coleta, e a tela continua verde porque do lado de cá nada dá erro quando nada
 * chega.
 */
eq("preenchido mas NÃO verificado fica na base",
  enderecoDoColetor({ coletor: "t.loja.com.br", coletorVerificadoEm: null }, BASE), BASE);
eq("verificação ausente idem",
  enderecoDoColetor({ coletor: "t.loja.com.br" }, BASE), BASE);

/* ------------------------------------------------ o cookie do clickId -- */

console.log("\n== o coletor só devolve cookie quando ele COLA ==");

/*
 * Reimplementa cookieDoClickId. As três condições são de segurança, e cada uma
 * fecha um buraco diferente — estão nomeadas no comentário do route.ts.
 */
function cookieDePrimeiraParte({ host, origem, dominioDoSite: guardado, nome = "_rr_cid", valor }) {
  const registravel = dominioRegistravel(guardado);
  if (!registravel) return null;
  if (!host || !mesmoSite(host, registravel)) return null;
  if (origem) {
    try {
      if (!mesmoSite(new URL(origem).hostname, registravel)) return null;
    } catch { return null; }
  }
  return `${nome}=${encodeURIComponent(valor)}`
    + `; Domain=.${registravel}; Path=/; Max-Age=${90 * 86400}`
    + "; SameSite=Lax; Secure";
}

const CID = "3f8a1c2e-0000-4000-8000-abcdefabcdef";
const caso = (extra) => cookieDePrimeiraParte({
  host: "t.loja.com.br",
  origem: "https://www.loja.com.br",
  dominioDoSite: "loja.com.br",
  valor: CID,
  ...extra,
});

const bom = caso({});
eq("o caminho feliz devolve cookie", bom !== null, true);
eq("no domínio registrável, com ponto", bom.includes("Domain=.loja.com.br"), true);
eq("90 dias, o mesmo COOKIE_DAYS do rr.js", bom.includes(`Max-Age=${90 * 86400}`), true);
/* Strict esconderia o cookie justamente na volta do gateway, que é quando ele serve. */
eq("Lax, para sobreviver à volta do gateway", bom.includes("SameSite=Lax"), true);
eq("Secure", bom.includes("; Secure"), true);

console.log("\n  -- e cala a boca quando não colaria --");
/* Sem subdomínio configurado o pedido chega no domínio do RRTrack: o navegador
   recusaria Domain=.loja.com.br vindo dali, então nem mandamos. */
eq("host fora do domínio do site", caso({ host: "rr-track.vercel.app" }), null);
eq("sem host", caso({ host: null }), null);

console.log("\n  -- e recusa quem tentaria fixar o clickId de outro --");
/*
 * Sem a checagem de origem, uma página qualquer na internet poderia gravar um
 * clickId escolhido por ela no visitante da loja — e toda venda daquela pessoa
 * passaria a ser creditada ao anúncio do atacante.
 */
eq("origem de outro site", caso({ origem: "https://evil.com" }), null);
eq("origem que só PARECE o domínio", caso({ origem: "https://loja.com.br.evil.com" }), null);
eq("origem quebrada", caso({ origem: "nao-e-url" }), null);
eq("sem origem (mesma origem) passa", caso({ origem: null }) !== null, true);

/* ------------------------------- os nomes de coluna escritos à mão -- */

console.log("\n== todo EXCLUDED.<coluna> existe mesmo em click_sessions ==");

/*
 * O upsert de `/api/collect` monta o `COALESCE(EXCLUDED.x, …)` com `x` escrito
 * como TEXTO dentro de `sql`. Do lado esquerdo do COALESCE o TypeScript não
 * enxerga nada: `EXCLUDED.ga_client_id` e `EXCLUDED.gaClientId` compilam
 * iguais, e o segundo só falha quando o Postgres recebe a consulta — ou seja,
 * em produção, com 500 em TODO beacon do site.
 *
 * O erro nem precisa ser de digitação: basta renomear uma coluna no schema e
 * esquecer de acompanhar aqui. São 25 ocorrências hoje; conferir uma a uma na
 * revisão é exatamente o tipo de coisa que passa.
 *
 * A lista de colunas vem do OBJETO do drizzle, não de uma cópia: é a mesma
 * definição que gera a migração.
 */
const { getTableColumns } = await import("../node_modules/drizzle-orm/index.js");
const { clickSessions } = await import("../_tmp/db/schema.js");

const colunas = new Set(Object.values(getTableColumns(clickSessions)).map((c) => c.name));
eq("o schema tem as colunas do GA4",
  colunas.has("ga_client_id") && colunas.has("ga_session_id"), true);

const citadas = [...new Set(
  [...ler("app/api/collect/route.ts").matchAll(/EXCLUDED\.([A-Za-z_][A-Za-z0-9_]*)/g)]
    .map((m) => m[1]),
)];
eq("a rota cita colunas de verdade", citadas.length > 20, true);

const inventadas = citadas.filter((c) => !colunas.has(c));
eq(`nenhuma das ${citadas.length} é inventada`, inventadas, []);

/* ------------------------------------------- as duas metades ligadas -- */

console.log("\n== as duas metades estão realmente ligadas ==");
const rr = ler("public/rr.js");
const rota = ler("app/api/collect/route.ts");
const tsx = ler("src/ui/integracoes.tsx");

/* Sem allow-credentials o navegador DESCARTA o Set-Cookie entre origens. */
eq("o CORS aceita credencial", rota.includes("access-control-allow-credentials"), true);
/* Com credencial, "*" é recusado pela especificação: a origem tem de ser exata. */
eq("a origem é ecoada, não curinga", rota.includes('origin ?? "*"'), true);
eq("o fetch de reserva manda credencial", rr.includes('credentials: "include"'), true);
/*
 * DOIS cookies saem na mesma resposta. Objeto simples sobrescreveria a chave
 * repetida e o segundo sumiria calado; por isso a rota usa Headers.append.
 */
eq("o external_id também vem do servidor", rota.includes('"_rr_eid"'), true);
eq("e os dois cabem na resposta", rota.includes('headers.append("set-cookie"'), true);
eq("o rr.js sai da frente no external_id também",
  /if \(!eidNoCookie \|\| !coletorMesmoSite\)/.test(rr), true);
/* Reescrever o cookie por JS a cada página desfaria o do servidor. */
eq("o rr.js sai da frente quando o coletor é do mesmo site",
  /if \(!cidNoCookie \|\| !coletorMesmoSite\)/.test(rr), true);
eq("o snippet usa o endereço do coletor, não a base",
  tsx.includes('src="${origem}/rr.js"'), true);
eq("e o endpoint também", tsx.includes('endpoint:"${origem}/rr/collect"'), true);
/*
 * Trocar de loja no seletor tem de REMONTAR os dois componentes que guardam
 * texto digitado. Sem `key`, o inicializador do useState não roda de novo e o
 * campo segue mostrando o valor da loja anterior — no coletor isso faz
 * verificar o host de uma loja estando em outra; no produto, salvar grava a
 * oferta errada na configuração da outra.
 */
eq("o coletor remonta ao trocar de loja",
  /<Coletor key=\{site\.chave\}/.test(tsx), true);
eq("o produto da página também",
  /<ProdutoDaPagina key=\{site\.chave\}/.test(tsx), true);
/* O palpite do campo precisa sair limpo mesmo com domínio guardado como URL. */
eq("o palpite do coletor passa pelo limpador",
  /const sugestao = `t\.\$\{dominioDoSite\(site\.dominio\)\}`;/.test(tsx), true);

eq("o snippet exige verificação, não só o campo preenchido",
  /if \(!c \|\| !site\.coletorVerificadoEm\) return base;/.test(tsx), true);
/* Verificação que falha tem de ZERAR a data, ou a loja fica apontando para um
   host morto até alguém reparar. */
eq("a verificação que falha zera a data",
  ler("app/api/integracoes/coletor/route.ts").includes("collectorVerifiedAt: null"), true);
/* Coletor fora do domínio do site viraria JavaScript de terceiro no site da
   loja, assinado pela nossa tela de configuração. */
eq("o coletor proposto é preso ao domínio do site",
  ler("app/api/integracoes/coletor/route.ts").includes("tem de ser um subdomínio de"), true);

console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
process.exit(f === 0 ? 0 : 1);
