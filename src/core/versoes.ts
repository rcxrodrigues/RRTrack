/*
 * Versão de cada API externa, num lugar só.
 *
 * Estava repetida: `v23.0` aparecia em `destinations/meta.ts`, `ads/meta.ts` e
 * `ads/meta-oauth.ts`, cada um lendo a mesma variável de ambiente por conta
 * própria. Enquanto os três estão iguais ninguém percebe; no dia da troca, quem
 * atualizar dois dos três cria o pior defeito possível — o gasto passa a ser
 * lido numa versão e a conversão enviada em outra, as duas funcionam, e os
 * números do painel divergem sem nenhum erro aparecer.
 *
 * Por isso a constante é única por plataforma, e não uma por arquivo.
 *
 * COMO ATUALIZAR: troque o número aqui. A variável de ambiente continua
 * valendo, e é o caminho para testar uma versão nova em produção sem subir
 * código — mas o padrão do repositório é este arquivo.
 *
 * COMO CONFERIR que a versão nova funciona: o botão "Testar conexão" de cada
 * conta, na tela de Integrações. Ele faz uma chamada real e mostra o que a
 * plataforma respondeu. Subir versão sem clicar nele é apostar.
 */

/*
 * Lê a variável de ambiente, tratando VAZIO como ausente.
 *
 * `??` só cai no padrão para `undefined` e `null`. Uma variável declarada e
 * vazia — que é como o .env.example a apresenta, e como a Vercel devolve um
 * campo que alguém limpou sem apagar — passaria reto, e a URL sairia
 * `https://graph.facebook.com//events`: 404 em toda chamada, por causa de uma
 * barra a mais que ninguém procura.
 *
 * Exportada porque é ela que o teste exercita. A alternativa seria reimportar o
 * módulo com ambientes diferentes, e isso NÃO funciona aqui: a suíte compila
 * para CommonJS, cujo cache é chaveado pelo caminho do arquivo e ignora a query
 * que serviria para furá-lo — os quatro cenários receberiam a mesma instância, e
 * o teste passaria sem testar nada.
 */
export function versao(valor: string | undefined, padrao: string): string {
  const limpo = valor?.trim();
  return limpo ? limpo : padrao;
}

/*
 * Meta — Graph API e Marketing API, que andam juntas na mesma numeração.
 *
 * A v26.0 saiu em 29/07/2026. A Meta mantém cada versão por cerca de dois anos
 * e derruba sem aviso no dia; ficar três versões atrás, como estávamos, é
 * confortável até deixar de ser.
 *
 * Duas superfícies diferentes usam este número, e o risco delas não é o mesmo:
 *
 *   `/events` (Conversions API) — o formato de `user_data` e `custom_data` não
 *     muda entre versões. Subir aqui é quase sem risco.
 *
 *   `/insights` (Marketing API) — muda. Cada versão aposenta métrica, e o
 *     sintoma é um campo vindo vazio, não um erro. Os campos que pedimos em
 *     `ads/meta.ts` são os de sempre (spend, impressions, clicks, ids, nomes,
 *     actions, action_values), que é o subconjunto que a Meta menos mexe —
 *     mas é aqui que se olha primeiro se o gasto sumir depois de uma troca.
 */
export const META_GRAPH = versao(process.env.META_GRAPH_VERSION, "v26.0");

/** `https://graph.facebook.com/v26.0`, montado uma vez. */
export const META_GRAPH_URL = `https://graph.facebook.com/${META_GRAPH}`;

/*
 * Google Ads.
 *
 * DELIBERADAMENTE ATRÁS, e isto não é esquecimento: a v21 continua aqui porque
 * as versões maiores do Google Ads quebram de verdade — campo renomeado, enum
 * removido, formato de `uploadClickConversions` alterado — e eu não consegui
 * ler a página de sunset para saber o que mudou de v21 até a atual
 * (`developers.google.com` está bloqueado pelo proxy desta sessão).
 *
 * Subir às cegas aqui tem um custo assimétrico: se o formato mudou, a conversão
 * para de subir e ninguém nota, porque não existe tela que mostre uma venda que
 * o Google não recebeu. Preferi deixar funcionando e visível a trocar por um
 * número mais bonito que talvez não funcione.
 *
 * PARA ATUALIZAR: leia o release notes da versão alvo, confira o formato de
 * `uploadClickConversions` em `destinations/google.ts`, troque aqui, e clique
 * em "Testar conexão" antes de considerar feito.
 */
export const GOOGLE_ADS = versao(process.env.GOOGLE_ADS_VERSION, "v21");
