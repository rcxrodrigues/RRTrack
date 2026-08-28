/*
 * Quem é robô e quem é gente.
 *
 * O erro barato aqui é deixar passar um robô: o painel conta um visitante a
 * mais. O erro caro é o contrário — descartar uma pessoa de verdade faz a
 * sessão dela nunca existir, e com ela some a venda do painel e a conversão
 * que iria para a plataforma de anúncio. Não há sintoma: o número só fica
 * menor do que deveria, para sempre.
 *
 * Por isso a maior parte deste arquivo são agentes de GENTE que precisam
 * passar. O caso que resume o risco é o telefone Cubot: tem "bot" no nome e
 * é uma pessoa segurando um celular.
 *
 * O navegador embutido do Facebook (FBAN/FB4A) também precisa passar, e não é
 * detalhe: no tráfego pago de Instagram e Facebook ele é a MAIORIA dos
 * compradores. Descartá-lo esvaziaria o painel inteiro.
 *
 * Compilar antes:
 *   npx tsc src/core/robos.ts --outDir _tmp --target ES2022 --module commonjs \
 *     --moduleResolution node --skipLibCheck --esModuleInterop --strict
 *   echo {"type":"commonjs"} > _tmp/package.json
 *   node scripts/teste-robos.cjs
 */
const { ehRobo } = require("../_tmp/core/robos.js");
const { ehRedeDaMeta, totalDeFaixas } = require("../_tmp/core/redes.js");

let f = 0;
const ok = (l, c, e = "") => {
  if (!c) f++;
  console.log(`  ${c ? "ok  " : "FALHA"} | ${l}${e ? "  → " + e : ""}`);
};

/* ------------------------------------------------------------- é gente -- */

const GENTE = [
  ["iPhone no Safari",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"],
  ["Android no Chrome",
    "Mozilla/5.0 (Linux; Android 16; SM-S721B Build/BP4A.251205.006; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36"],
  ["Windows no Chrome",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"],
  ["Mac no Safari",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"],
  /*
   * O navegador dentro do app do Facebook. É por onde entra a maior parte do
   * tráfego pago de Meta — descartar isto seria descartar a operação.
   */
  ["navegador do app do Facebook",
    "Mozilla/5.0 (Linux; Android 16; SM-A536E Build/UP1A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 [FBAN/FB4A;FBAV/574.0.0.40.71;FBBV/1038038883;FBDM/{density=3.75};FBLC/pt_BR]"],
  ["navegador do app do Instagram",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 336.0.0.25.90"],
  ["navegador do app do TikTok",
    "Mozilla/5.0 (Linux; Android 13; SM-A135M) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 trill_370405 BytedanceWebview/d8a21c6"],
  /*
   * Cubot é marca de celular. Uma busca por "bot" solto descartaria o dono
   * deste aparelho — e é exatamente por isso que a regra usa limite de
   * palavra em vez de substring.
   */
  ["celular da marca Cubot",
    "Mozilla/5.0 (Linux; Android 12; CUBOT NOTE 20) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36"],
  ["Firefox no Linux",
    "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"],
  ["Edge no Windows",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0"],
  ["Samsung Internet",
    "Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36"],
];

console.log("\nGENTE — precisa passar");
for (const [rotulo, ua] of GENTE) {
  ok(rotulo, ehRobo(ua) === false, ehRobo(ua) ? "DESCARTADO por engano" : "");
}

/* -------------------------------------------------------------- é robô -- */

const ROBOS = [
  /* O que apareceu de verdade no tráfego da loja. */
  ["revisão de anúncio da Meta",
    "meta-externalads/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)"],
  ["prévia de link do Facebook",
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"],

  ["prévia do WhatsApp", "WhatsApp/2.2412.5 A"],
  ["Googlebot", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"],
  ["Bingbot", "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"],
  ["Ahrefs", "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)"],
  ["Semrush", "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)"],
  ["Applebot", "Mozilla/5.0 (compatible; Applebot/0.1; +http://www.apple.com/go/applebot)"],
  ["Telegram", "TelegramBot (like TwitterBot)"],
  ["Slack", "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)"],
  ["Discord", "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)"],
  ["LinkedIn", "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)"],
  ["curl", "curl/8.4.0"],
  ["wget", "Wget/1.21.3"],
  ["python", "python-requests/2.31.0"],
  ["Go", "Go-http-client/2.0"],
  ["Chrome sem cabeça", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36"],
  ["Lighthouse", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome-Lighthouse"],
  ["monitor de uptime", "Mozilla/5.0 (compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)"],
  ["aranha genérica", "Mozilla/5.0 (compatible; SomeSpider/1.0)"],
];

console.log("\nROBÔ — precisa ser descartado");
for (const [rotulo, ua] of ROBOS) {
  ok(rotulo, ehRobo(ua) === true, ehRobo(ua) ? "" : "PASSOU como gente");
}

console.log("\nSEM AGENTE");
ok("agente vazio é robô", ehRobo("") === true);
ok("agente só com espaço é robô", ehRobo("   ") === true);
ok("agente ausente é robô", ehRobo(null) === true);
ok("agente indefinido é robô", ehRobo(undefined) === true);

/* ------------------------------------------------------------ pelo IP -- */

/*
 * O agente resolve metade do problema. A revisão de anúncio da Meta usa o
 * MESMO agente do app do Facebook — o de um comprador de verdade — e só o IP
 * separa. Os endereços abaixo saíram do tráfego real da Florè.
 */
console.log("\nIP DA META — precisa ser descartado");
const DA_META = [
  ["Gallatin",   "173.252.70.35"],
  ["Fort Worth", "173.252.87.52"],
  ["Luleå",      "31.13.115.2"],
  ["Luleå",      "31.13.115.114"],
  ["Prineville", "66.220.149.32"],
  ["Prineville", "66.220.149.8"],
];
for (const [onde, ip] of DA_META) {
  ok(`${onde} (${ip})`, ehRedeDaMeta(ip) === true, ehRedeDaMeta(ip) ? "" : "PASSOU como gente");
}

console.log("\nIP DE GENTE — precisa passar");
const DE_GENTE = [
  ["Belo Horizonte",     "177.55.225.163"],
  ["Maceió",             "45.161.75.124"],
  ["Passo Fundo",        "131.221.14.70"],
  ["Sobral",             "177.37.186.63"],
  ["Curitiba",           "177.220.180.45"],
  ["São Paulo",          "187.26.175.8"],
  ["Balneário Camboriú", "179.221.201.10"],
];
for (const [onde, ip] of DE_GENTE) {
  ok(`${onde} (${ip})`, ehRedeDaMeta(ip) === false, ehRedeDaMeta(ip) ? "DESCARTADO por engano" : "");
}

console.log("\nENTRADA ESTRANHA — na dúvida, é gente");
ok("IP vazio passa", ehRedeDaMeta("") === false);
ok("IP nulo passa", ehRedeDaMeta(null) === false);
ok("texto qualquer passa", ehRedeDaMeta("nao-e-um-ip") === false);
ok("octeto acima de 255 passa", ehRedeDaMeta("999.1.1.1") === false);
ok("IPv6 brasileiro passa", ehRedeDaMeta("2804:14d:1::1") === false);

/*
 * A lista carregada não pode estar vazia. Um arquivo de faixas truncado não
 * daria erro em lugar nenhum — só desligaria o filtro em silêncio, e voltaria
 * a contar robô como visitante sem ninguém perceber.
 */
console.log("\nA LISTA DE FAIXAS");
const faixas = totalDeFaixas();
ok("há faixas IPv4 carregadas", faixas.v4 > 100, `${faixas.v4} faixas`);
ok("há faixas IPv6 carregadas", faixas.v6 > 100, `${faixas.v6} faixas`);

console.log(`\n${f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)"}`);
process.exit(f === 0 ? 0 : 1);
