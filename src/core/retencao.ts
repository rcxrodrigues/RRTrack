/*
 * Retenção: o banco para de crescer sem parar.
 *
 * Três colunas guardam o corpo inteiro do que passou e nunca eram limpas:
 * `dispatches.request_body`, `dispatches.response_body` e
 * `webhook_deliveries.raw_body`. Cada venda escreve nas três, cada reentrega
 * escreve de novo, e nada apaga. Não quebra nada hoje; quebra no dia em que o
 * banco encostar no limite do plano, que é um dia ruim para descobrir.
 *
 * ZERA, NÃO APAGA. A linha fica: data, evento, status, chaves de
 * correspondência, tenant. É o que o painel lê, é o que a reconciliação usa, e
 * é o que responde "essa venda foi enviada?" seis meses depois. O que sai é só
 * o corpo — que serve para depurar na semana seguinte e para nada depois.
 *
 * O QUE NÃO PODE SER ZERADO, e por quê:
 *
 *   Disparo com `next_attempt_at` marcado está NA FILA DE REENVIO, e o reenvio
 *   reconstrói o pedido a partir do `request_body` guardado — é para isso que
 *   ele existe. Zerar ali faria `reenviarPendentes` desistir com "sem payload
 *   guardado para reenviar", e a conversão morreria em silêncio. Por isso o
 *   corte exige `next_attempt_at IS NULL`.
 *
 *   `raw_body` é NOT NULL no schema, então vira string vazia em vez de NULL.
 *   Um UPDATE para NULL ali não limpa nada: estoura a restrição e a rotina
 *   inteira falha.
 *
 * EM LOTES, e com relógio. Um UPDATE em milhões de linhas trava a tabela e
 * estoura o tempo da função. Cada lote é pequeno, e a rotina para sozinha antes
 * do teto de tempo dizendo que ficou trabalho — a execução seguinte continua de
 * onde esta parou, porque a condição é sempre "o que ainda tem corpo".
 */

import { sql } from "drizzle-orm";
import { db } from "../db/index";

/*
 * Catorze dias.
 *
 * O prazo saiu de para que o corpo serve: investigar "por que esta venda não
 * chegou à Meta" acontece na mesma semana, no máximo na seguinte. Passado
 * isso, ninguém abre o payload de novo — e quem abrir vai querer o
 * `match_keys` e o `error`, que ficam.
 */
export const DIAS_PADRAO = 14;

/* Pequeno de propósito: lote grande trava a tabela e estoura o tempo. */
export const LOTE_PADRAO = 2000;

/*
 * Teto de tempo, abaixo do limite da função na Vercel.
 *
 * Estourar o limite mata a execução NO MEIO — o que já foi zerado fica, mas
 * ninguém fica sabendo quanto faltou, e o log mostra só um timeout. Parando por
 * conta própria, a rotina relata `truncado` e a execução de amanhã termina o
 * serviço.
 */
export const TETO_MS_PADRAO = 45_000;

export interface Relatorio {
  disparos: number;
  entregas: number;
  contadores: number;
  lotes: number;
  /** Bateu no teto de tempo e parou no meio. A próxima execução continua. */
  truncado: boolean;
  ms: number;
}

export interface Opcoes {
  dias?: number;
  lote?: number;
  tetoMs?: number;
  agora?: Date;
}

/** O corte: linhas anteriores a esta data perdem o corpo. */
export function corteDe(agora: Date, dias: number): Date {
  return new Date(agora.getTime() - dias * 86_400_000);
}

/**
 * Passou do tempo de continuar?
 *
 * Pura e exportada porque é a única lógica aqui que dá para testar sem banco —
 * e porque errá-la nos dois sentidos custa: parar cedo demais faz a limpeza
 * nunca alcançar o acúmulo, e parar tarde demais é a função morrer no meio.
 */
export function acabouOTempo(inicioMs: number, tetoMs: number, agoraMs: number): boolean {
  return agoraMs - inicioMs >= tetoMs;
}

export async function aplicarRetencao(opcoes: Opcoes = {}): Promise<Relatorio> {
  const dias = opcoes.dias ?? DIAS_PADRAO;
  const lote = opcoes.lote ?? LOTE_PADRAO;
  const tetoMs = opcoes.tetoMs ?? TETO_MS_PADRAO;
  const inicio = Date.now();
  const corte = corteDe(opcoes.agora ?? new Date(), dias);

  const r: Relatorio = {
    disparos: 0, entregas: 0, contadores: 0, lotes: 0, truncado: false, ms: 0,
  };

  /*
   * Os contadores da contenção primeiro: é uma linha por IP por minuto, então
   * é de longe o que mais acumula, e é a única das quatro em que apagar a
   * linha inteira é correto — ela não é histórico de nada. Ver core/contencao.ts.
   */
  for (;;) {
    if (acabouOTempo(inicio, tetoMs, Date.now())) { r.truncado = true; break; }
    const apagadas = await db.execute(sql`
      DELETE FROM rate_limits
      WHERE chave IN (
        SELECT chave FROM rate_limits WHERE expira_em < now() LIMIT ${lote}
      )`);
    r.lotes++;
    const n = apagadas.rowCount ?? 0;
    r.contadores += n;
    if (n < lote) break;
  }

  /*
   * Disparos. O `next_attempt_at IS NULL` é a linha que protege a fila de
   * reenvio — ver o cabeçalho. O `IS NOT NULL` nos corpos é o que faz a
   * varredura encolher a cada execução em vez de reprocessar o já limpo.
   */
  for (;;) {
    if (acabouOTempo(inicio, tetoMs, Date.now())) { r.truncado = true; break; }
    const limpas = await db.execute(sql`
      UPDATE dispatches SET request_body = NULL, response_body = NULL
      WHERE id IN (
        SELECT id FROM dispatches
        WHERE created_at < ${corte}
          AND next_attempt_at IS NULL
          AND (request_body IS NOT NULL OR response_body IS NOT NULL)
        LIMIT ${lote}
      )`);
    r.lotes++;
    const n = limpas.rowCount ?? 0;
    r.disparos += n;
    if (n < lote) break;
  }

  /*
   * Entregas de webhook. `raw_body` é NOT NULL, então vai para string vazia —
   * e o `<> ''` é o que impede a rotina de varrer para sempre as mesmas linhas
   * já limpas, achando que ainda há trabalho.
   */
  for (;;) {
    if (acabouOTempo(inicio, tetoMs, Date.now())) { r.truncado = true; break; }
    const limpas = await db.execute(sql`
      UPDATE webhook_deliveries SET raw_body = ''
      WHERE id IN (
        SELECT id FROM webhook_deliveries
        WHERE received_at < ${corte} AND raw_body <> ''
        LIMIT ${lote}
      )`);
    r.lotes++;
    const n = limpas.rowCount ?? 0;
    r.entregas += n;
    if (n < lote) break;
  }

  r.ms = Date.now() - inicio;
  return r;
}

/**
 * Há corpo velho parado? É como se descobre que a rotina parou de rodar.
 *
 * Uma rotina agendada que deixa de disparar não dá erro em lugar nenhum: o
 * cron some, o `CRON_SECRET` é trocado, o `vercel.json` se perde num merge — e
 * o sintoma é o banco crescendo de novo, que ninguém olha até doer.
 *
 * Isto não pergunta "a rotina rodou", que exigiria guardar estado. Pergunta o
 * que interessa de verdade: SOBROU trabalho que já devia ter sido feito. Se
 * sobrou, ou ela não rodou ou não está dando conta, e os dois pedem a mesma
 * atenção.
 */
export async function corpoVelhoParado(dias = DIAS_PADRAO): Promise<number> {
  const corte = corteDe(new Date(), dias);
  const r = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM dispatches
        WHERE created_at < ${corte} AND next_attempt_at IS NULL
          AND (request_body IS NOT NULL OR response_body IS NOT NULL))
      +
      (SELECT count(*) FROM webhook_deliveries
        WHERE received_at < ${corte} AND raw_body <> '')
      AS total`);
  return Number((r.rows[0] as { total?: string | number } | undefined)?.total ?? 0);
}
