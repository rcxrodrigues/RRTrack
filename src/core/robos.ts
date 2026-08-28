/*
 * Quem não é gente.
 *
 * Descoberto olhando o primeiro dia de tráfego pago de verdade: das 71 sessões
 * de uma semana, 37 vinham de datacenter da Meta — Prineville, Luleå, Clonee,
 * Forest City. Nenhuma delas é uma pessoa. São a revisão de anúncio e o
 * gerador de prévia de link, que abrem a página para conferir o que o anúncio
 * mostra.
 *
 * O estrago não é o número inflado, é o número CRÍVEL. "26 visitantes" parece
 * um dia fraco de campanha nova; ninguém desconfia que metade eram robôs da
 * própria plataforma. E o efeito colateral é pior que a contagem: com o
 * denominador inchado, toda taxa de conversão do funil aparece pela metade, e
 * a lista de estados fica encabeçada por Oregon em vez de São Paulo.
 *
 * O corte aqui é deliberadamente CONSERVADOR: só descarta quem se declara
 * robô no próprio agente. Robô que se disfarça de navegador continua passando,
 * e é assunto separado — errar para o lado de contar um robô é ruim, mas
 * descartar um comprador de verdade é pior, porque some a venda dele do
 * painel e a conversão nunca é enviada para a plataforma.
 */

/*
 * A regra não é simétrica de propósito.
 *
 * "crawler", "spider", "scraper" e "slurp" podem ser procurados soltos: nenhum
 * navegador e nenhuma marca de aparelho carrega essas palavras, então casar no
 * meio de outra ("Baiduspider", "YisouSpider") é ganho sem risco.
 *
 * "bot" NÃO pode. Existe telefone da marca Cubot, e procurar a substring solta
 * descartaria o comprador que estiver com um deles na mão. Aqui exigimos ou a
 * palavra isolada, ou a forma "bot/1.0" com que todo robô se versiona — que é
 * o que separa "FooBot/2.1" de "CUBOT NOTE 20".
 */
const RASTEJANTES = /(crawler|spider|scraper|slurp)/i;
const DECLARADOS = /\bbot\b|bot\//i;

/*
 * Nomes que não passam pela regra acima porque vêm colados, ou porque não
 * carregam a palavra. Cada um é um caso visto na prática.
 */
const CONHECIDOS = [
  /* Meta: revisão de anúncio e prévia de link. É o volume desta lista. */
  "meta-externalads",
  "facebookexternalhit",
  "facebookcatalog",

  /* Prévia de link dos mensageiros. */
  "whatsapp",
  "telegrambot",
  "discordbot",
  "slackbot",
  "linkedinbot",
  "twitterbot",
  "skypeuripreview",
  "embedly",
  "quora link preview",

  /* Buscadores e ferramentas de SEO. */
  "googlebot",
  "bingbot",
  "yandex",
  "baiduspider",
  "duckduckbot",
  "applebot",
  "ahrefs",
  "semrush",
  "mj12",
  "dotbot",
  "petalbot",
  "screaming frog",

  /* Automação e medição — sobem em teste e em auditoria de performance. */
  "headlesschrome",
  "phantomjs",
  "puppeteer",
  "playwright",
  "selenium",
  "lighthouse",
  "chrome-lighthouse",
  "pagespeed",
  "gtmetrix",
  "pingdom",
  "uptimerobot",

  /* Clientes de linha de comando e biblioteca: nunca são um comprador. */
  "curl/",
  "wget",
  "python-requests",
  "go-http-client",
  "okhttp",
  "axios/",
  "node-fetch",
  "postman",
  "insomnia",
];

/**
 * `true` quando o agente se declara robô.
 *
 * Agente ausente também conta: navegador de verdade sempre manda um, e beacon
 * sem agente nenhum é script.
 */
export function ehRobo(userAgent: string | null | undefined): boolean {
  if (!userAgent || !userAgent.trim()) return true;

  const ua = userAgent.toLowerCase();
  if (CONHECIDOS.some((n) => ua.includes(n))) return true;

  return RASTEJANTES.test(ua) || DECLARADOS.test(ua);
}
