/*
 * Domínio: como se lê o que está guardado, e onde um cookie pode valer.
 *
 * Existe porque `sites.domain` NÃO tem um formato só. No banco de produção
 * convivem "florecomesticos.store" e "https://transforlar.com/" — a segunda com
 * esquema e barra final, porque em algum momento alguém colou a URL inteira no
 * campo e nada reclamou.
 *
 * O estrago dessa diferença é invisível e duplo:
 *
 *   dominioRegistravel("https://transforlar.com/") devolvia a string inteira,
 *   então comparar com "track.transforlar.com" dava FALSO, e a verificação do
 *   coletor recusava um subdomínio legítimo dizendo que ele não pertencia ao
 *   site.
 *
 *   E o cookie saía `Domain=.transforlar.com/` — com barra. Domínio de cookie
 *   não aceita barra, então o navegador o descartava sem avisar ninguém.
 *
 * Nenhum dos dois dá erro em lugar nenhum. Por isso a normalização vive aqui,
 * num lugar só, e é aplicada na LEITURA: consertar só a escrita deixaria as
 * linhas já gravadas quebradas para sempre.
 */

/*
 * Sufixos públicos de duas partes, onde o domínio registrável tem três.
 *
 * Esta lista é uma CÓPIA da que vive em `public/rr.js`, e a cópia é
 * inevitável: aquele arquivo é servido estático ao navegador do visitante e
 * não pode importar daqui. Quando as duas divergiram, o servidor mandava
 * `Domain=.me.uk` — que o navegador recusa por ser sufixo público — e o cookie
 * simplesmente não existia para aquelas lojas, calado.
 *
 * `scripts/teste-coletor.mjs` compara as duas a cada execução e reprova se
 * saírem do ar. É a única coisa que impede a divergência de voltar.
 */
export const COMPOSTOS = new Set([
  "com.br", "net.br", "org.br", "com.pt",
  "co.uk", "org.uk", "me.uk", "ac.uk",
  "com.au", "net.au", "org.au",
  "co.jp", "co.nz", "co.za", "co.in", "com.mx", "com.ar", "com.co",
]);

/*
 * Tira de um valor guardado tudo que não é host: esquema, caminho, porta,
 * credencial de URL, e o `www.` da frente.
 *
 * O `www.` sai porque cookie e coletor raciocinam em domínio registrável, e
 * "www.loja.com.br" e "loja.com.br" são a mesma loja para os dois. Mantê-lo
 * faria `dominioRegistravel` trabalhar com uma parte a mais sem necessidade.
 */
export function dominioDoSite(guardado: string): string {
  let s = guardado.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");  /* esquema */
  s = s.replace(/^[^/@]*@/, "");                  /* usuário:senha@ */
  s = s.replace(/[/?#].*$/, "");                  /* caminho, query, âncora */
  s = s.replace(/:\d+$/, "");                     /* porta */
  s = s.replace(/^www\./, "");
  return s;
}

/**
 * O domínio em que um cookie pode ser gravado: "www.loja.com.br" -> "loja.com.br".
 *
 * Aceita valor sujo — chama `dominioDoSite` antes — porque quem chama quase
 * sempre está segurando algo que veio do banco ou de um cabeçalho, e exigir
 * limpeza prévia é o tipo de contrato que alguém esquece uma vez e ninguém
 * descobre.
 */
export function dominioRegistravel(host: string): string {
  const limpo = dominioDoSite(host);
  const partes = limpo.split(".");
  if (partes.length <= 2) return partes.join(".");
  const dois = partes.slice(-2).join(".");
  return COMPOSTOS.has(dois) ? partes.slice(-3).join(".") : dois;
}

/** Duas coisas são do mesmo site quando caem no mesmo domínio registrável. */
export function mesmoSite(a: string, b: string): boolean {
  const x = dominioRegistravel(a);
  return !!x && x === dominioRegistravel(b);
}

/**
 * Valida e limpa um host que uma PESSOA digitou.
 *
 * Devolve `null` para o que não é hostname plausível, em vez de tentar
 * adivinhar: um coletor cadastrado errado não dá erro — ele só deixa de
 * coletar, meses depois, sem nada aparecer.
 */
export function normalizarHost(bruto: string): string | null {
  const limpo = dominioDoSite(bruto);
  if (!limpo || !/^[a-z0-9.-]+$/.test(limpo) || !limpo.includes(".")) return null;
  if (limpo.startsWith(".") || limpo.endsWith(".") || limpo.includes("..")) return null;
  return limpo;
}
