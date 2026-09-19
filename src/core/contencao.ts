/*
 * Contenção dos endpoints públicos.
 *
 * `/api/collect` e `/api/webhook/<gateway>/<segredo>` são abertos para a
 * internet inteira: qualquer um pode chamá-los sem credencial. Sem contenção,
 * um laço de trinta linhas enche `events` e `click_sessions` até o banco doer,
 * e a conta chega antes do alerta.
 *
 * ESTES TETOS NÃO MOLDAM TRÁFEGO. São teto de abuso, e por isso são folgados
 * de propósito: bloquear coleta legítima é perda SILENCIOSA de atribuição — o
 * evento não chega, nada dá erro, e a venda aparece como tráfego direto semanas
 * depois. Entre deixar passar um abuso e barrar um comprador, barrar o
 * comprador é o erro caro.
 *
 * JANELA FIXA, não deslizante, e a diferença é assumida. Deslizante exigiria
 * guardar carimbo por requisição — mais escrita no caminho mais quente do
 * sistema, justamente o que se quer proteger. O custo da fixa é conhecido:
 * quem acerta a virada da janela consegue até o DOBRO do teto num intervalo
 * curto. Para teto de abuso isso não muda nada; para cota comercial mudaria, e
 * aí seria outro desenho.
 *
 * SEM TRAVA EM MEMÓRIA, pela regra 5: em serverless o processo morre entre
 * requisições e a trava morre junto. A contagem é uma linha no Postgres, e o
 * incremento é um upsert atômico — duas funções simultâneas somam, não se
 * sobrescrevem.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/index";
import { rateLimits } from "../db/schema";

/*
 * O identificador da janela: quantas janelas inteiras cabem desde 1970.
 *
 * Função pura e exportada de propósito — é ela que tem teste. Testar isto
 * reimportando o módulo com query para furar cache NÃO funciona nesta suíte
 * (ela compila para CommonJS, cujo cache ignora a query), e já custou um teste
 * que passava sem testar nada.
 */
export function janelaDe(agoraMs: number, segundos: number): number {
  return Math.floor(agoraMs / 1000 / segundos);
}

/** Quando a janela atual vira, em ms desde 1970. */
export function fimDaJanela(agoraMs: number, segundos: number): number {
  return (janelaDe(agoraMs, segundos) + 1) * segundos * 1000;
}

/**
 * A chave da linha de contagem.
 *
 * A janela entra na CHAVE, e não numa coluna: assim cada janela é uma linha
 * nova e a anterior morre sozinha por validade, sem ninguém precisar zerar
 * contador nenhum. Zerar seria uma escrita a mais, no caminho quente, para
 * chegar ao mesmo lugar.
 */
export function chaveDe(escopo: string, quem: string, agoraMs: number, segundos: number): string {
  return `${escopo}:${quem}:${janelaDe(agoraMs, segundos)}`;
}

export interface Regra {
  /** O que está sendo contado: "collect:ip", "webhook:segredo". */
  escopo: string;
  /** Quem: o IP, a chave do site, o segredo do webhook. */
  quem: string;
  /** Quantas chamadas cabem na janela. */
  teto: number;
  /** O tamanho da janela, em segundos. */
  segundos: number;
}

/**
 * Monta o upsert que conta uma chamada.
 *
 * Devolve a consulta em vez de executá-la para poder entrar num `db.batch()` —
 * no `/api/collect` ela viaja junto da busca do site, e a contenção sai sem
 * custar uma ida a mais ao banco no caminho mais quente do sistema.
 *
 * `ON CONFLICT ... contagem + 1` é o ponto: o Postgres resolve a corrida entre
 * duas funções simultâneas. `RETURNING` devolve o valor DEPOIS de somar, que é
 * o que decide se passou do teto.
 */
export function contar(regra: Regra, agoraMs = Date.now()) {
  return db.insert(rateLimits).values({
    chave: chaveDe(regra.escopo, regra.quem, agoraMs, regra.segundos),
    contagem: 1,
    /*
     * Validade com folga de uma janela. Quem limpa é a rotina de retenção; a
     * folga existe para que uma limpeza adiantada não apague a janela em uso e
     * zere a contagem de quem está sendo contido nesse instante.
     */
    expiraEm: new Date(fimDaJanela(agoraMs, regra.segundos) + regra.segundos * 1000),
  }).onConflictDoUpdate({
    target: rateLimits.chave,
    set: { contagem: sql`${rateLimits.contagem} + 1` },
  }).returning({ contagem: rateLimits.contagem });
}

/** Passou do teto? `contagem` é o valor já somado, como o RETURNING devolve. */
export function estourou(contagem: number | undefined, teto: number): boolean {
  /*
   * `undefined` passa. É o caso de o upsert não ter devolvido linha — coisa que
   * não deveria acontecer, e que se acontecer é problema NOSSO. Barrar aí
   * transformaria um defeito nosso em coleta perdida do cliente, que é
   * exatamente a troca que não se quer fazer.
   */
  if (contagem === undefined) return false;
  return contagem > teto;
}

/**
 * A resposta de quem estourou.
 *
 * 429 com `Retry-After`, e não 403: 403 diz "você não tem permissão", que
 * convida a investigar credencial. 429 diz "volte depois", que é a verdade — e
 * é o único código que um gateway trata como transitório e reentrega. Um 4xx
 * permanente num webhook faria o gateway DESISTIR da venda.
 */
export function respostaDeEstouro(
  agoraMs: number, segundos: number, extra?: HeadersInit,
): Response {
  const esperar = Math.max(1, Math.ceil((fimDaJanela(agoraMs, segundos) - agoraMs) / 1000));
  const headers = new Headers(extra);
  headers.set("retry-after", String(esperar));
  return new Response(null, { status: 429, headers });
}

/*
 * Os tetos.
 *
 * Todos por minuto, e todos folgados — ver o cabeçalho. Os números saem do que
 * o tráfego legítimo faz no pior caso, multiplicado por uma margem grande:
 *
 *   COLETA POR IP. Um navegador manda um page_view por página, um pulso por
 *   minuto e um punhado de eventos por clique. Mesmo alguém navegando rápido
 *   não passa de algumas dezenas por minuto. 600 dá margem para a loja inteira
 *   de um escritório atrás de um IP só (NAT), que é o caso que barraria gente
 *   de verdade.
 *
 *   COLETA POR LOJA. 6.000/min é 100 eventos por segundo na mesma loja. Loja
 *   nenhuma daqui chega perto; se chegar, este número sobe — ele existe para
 *   impedir que UMA loja comprometida derrube o banco das outras.
 *
 *   WEBHOOK. 600/min por conexão. Gateway manda em rajada quando reentrega uma
 *   fila acumulada, e 429 nesse momento só adia — mas adiar venda é ruim, então
 *   o número é alto. Por IP existe separado porque um atacante vem de um IP só
 *   e sem segredo válido.
 */
export const TETOS = {
  coletaPorIp: { escopo: "collect:ip", teto: 600, segundos: 60 },
  coletaPorLoja: { escopo: "collect:site", teto: 6000, segundos: 60 },
  webhookPorConexao: { escopo: "webhook:conexao", teto: 600, segundos: 60 },
  webhookPorIp: { escopo: "webhook:ip", teto: 600, segundos: 60 },
} as const;

/*
 * Teto de corpo da requisição.
 *
 * Sem isto, um POST de 50 MB vira 50 MB de `raw_body` guardado para sempre —
 * `webhook_deliveries.raw_body` não tem retenção, então o estrago não passa.
 * Nenhum beacon legítimo chega perto: o maior deles, com carrinho cheio,
 * não passa de alguns kilobytes.
 */
export const CORPO_MAXIMO = 256 * 1024;

/**
 * O corpo cabe?
 *
 * Confere o `content-length` quando ele vem, e o tamanho real depois de ler
 * quando não vem — `Transfer-Encoding: chunked` não declara tamanho, e confiar
 * só no cabeçalho deixaria a porta aberta para quem simplesmente o omite.
 */
export function cabeNoLimite(declarado: string | null, lido?: number): boolean {
  const n = declarado === null ? NaN : Number(declarado);
  if (Number.isFinite(n) && n > CORPO_MAXIMO) return false;
  if (lido !== undefined && lido > CORPO_MAXIMO) return false;
  return true;
}
