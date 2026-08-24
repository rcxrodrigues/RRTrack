/*
 * Consultas da saúde do rastreamento.
 *
 * É a tela que a Utmify não tem, e a razão é estrutural: ela recebe a venda já
 * atribuída por outro sistema. O RRTrack É o sistema que atribui, então sabe de
 * onde veio cada certeza — e pode mostrar a diferença entre saber e supor.
 *
 * Dois números importam aqui, e nenhum é ROAS:
 *
 *   quanto do faturamento está atribuído POR CHAVE, e não por inferência
 *   quantas chaves de correspondência cada plataforma está recebendo
 *
 * O primeiro diz se o painel pode ser levado a sério. O segundo diz se o
 * algoritmo do anúncio está recebendo sinal bom ou migalha.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/index";
import type { Periodo } from "./resumo";

/*
 * O driver HTTP da Neon devolve `{ rows }`, e não a lista direto — diferente
 * do driver TCP. Este atalho isola a diferença num lugar só, para trocar de
 * driver um dia não virar caçada por todo o arquivo.
 */
async function linhasDe<T>(consulta: Promise<{ rows: T[] }>): Promise<T[]> {
  return (await consulta).rows;
}

/* -------------------------------------------------------- atribuição -- */

export interface Atribuicao {
  metodo: string;
  rotulo: string;
  explicacao: string;
  vendas: number;
  faturamentoCents: number;
  porChave: boolean;
}

const METODOS: Record<string, { rotulo: string; explicacao: string; porChave: boolean }> = {
  click_id: {
    rotulo: "click_id",
    explicacao: "o carimbo voltou no webhook",
    porChave: true,
  },
  order_claim: {
    rotulo: "order_claim",
    explicacao: "a loja registrou o pedido ao criá-lo",
    porChave: true,
  },
  fbp_match: {
    rotulo: "fbp_match",
    explicacao: "casado pelo cookie do navegador",
    porChave: false,
  },
  gateway_attribution: {
    rotulo: "gateway_attribution",
    explicacao: "só a UTM que o gateway guardou",
    porChave: false,
  },
  unattributed: {
    rotulo: "sem atribuição",
    explicacao: "venda órfã, sem origem",
    porChave: false,
  },
};

export async function porAtribuicao(p: Periodo): Promise<Atribuicao[]> {
  const linhas = await linhasDe(db.execute<{ metodo: string; vendas: number; faturamento: number }>(sql`
    SELECT attribution_method AS metodo,
      count(*)::int AS vendas,
      coalesce(sum(gross_cents), 0)::bigint AS faturamento
    FROM orders
    WHERE tenant_id = ${p.tenantId} AND status = 'paid'
      AND (occurred_at AT TIME ZONE ${p.timezone})::date BETWEEN ${p.de}::date AND ${p.ate}::date
    GROUP BY 1
  `));

  /* Ordem fixa, da maior certeza para a menor — não pela quantidade. A leitura
     é "quanto está em cada degrau de confiança", e degrau tem ordem. */
  const ordem = ["click_id", "order_claim", "fbp_match", "gateway_attribution", "unattributed"];

  return ordem.map((m) => {
    const l = linhas.find((x) => x.metodo === m);
    const meta = METODOS[m]!;
    return {
      metodo: m,
      rotulo: meta.rotulo,
      explicacao: meta.explicacao,
      porChave: meta.porChave,
      vendas: Number(l?.vendas ?? 0),
      faturamentoCents: Number(l?.faturamento ?? 0),
    };
  });
}

/* ------------------------------------------------ chaves por gateway -- */

export interface QualidadeGateway {
  gateway: string;
  disparos: number;
  mediaChaves: number | null;
  verificados: number;
}

export async function qualidadePorGateway(p: Periodo): Promise<QualidadeGateway[]> {
  const linhas = await linhasDe(db.execute<{
    gateway: string; disparos: number; media: number | null; verificados: number;
  }>(sql`
    SELECT gc.gateway,
      count(d.id)::int AS disparos,
      avg(d.match_key_count) FILTER (WHERE d.status = 'sent') AS media,
      count(*) FILTER (WHERE wd.verified)::int AS verificados
    FROM dispatches d
    JOIN orders o ON o.id = d.order_id
    JOIN gateway_connections gc ON gc.id = o.gateway_connection_id
    LEFT JOIN webhook_deliveries wd
      ON wd.gateway_connection_id = gc.id AND wd.tenant_id = o.tenant_id
    WHERE d.tenant_id = ${p.tenantId}
      AND (d.created_at AT TIME ZONE ${p.timezone})::date BETWEEN ${p.de}::date AND ${p.ate}::date
    GROUP BY 1
    ORDER BY media DESC NULLS LAST
  `));

  return linhas.map((l) => ({
    gateway: l.gateway,
    disparos: Number(l.disparos),
    mediaChaves: l.media === null ? null : Number(l.media),
    verificados: Number(l.verificados),
  }));
}

/* ---------------------------------------------------------- disparos -- */

export interface ResumoDisparos {
  entregues: number;
  falharam: number;
  ignorados: number;
  mediaChaves: number | null;
}

export async function resumoDisparos(p: Periodo): Promise<ResumoDisparos> {
  const [l] = await linhasDe(db.execute<{
    entregues: number; falharam: number; ignorados: number; media: number | null;
  }>(sql`
    SELECT
      count(*) FILTER (WHERE status = 'sent')::int    AS entregues,
      count(*) FILTER (WHERE status = 'failed')::int  AS falharam,
      count(*) FILTER (WHERE status = 'skipped')::int AS ignorados,
      avg(match_key_count) FILTER (WHERE status = 'sent') AS media
    FROM dispatches
    WHERE tenant_id = ${p.tenantId}
      AND (created_at AT TIME ZONE ${p.timezone})::date BETWEEN ${p.de}::date AND ${p.ate}::date
  `));

  return {
    entregues: Number(l?.entregues ?? 0),
    falharam: Number(l?.falharam ?? 0),
    ignorados: Number(l?.ignorados ?? 0),
    mediaChaves: l?.media == null ? null : Number(l.media),
  };
}

export interface Disparo {
  id: string;
  evento: string;
  eventId: string;
  estado: string;
  chaves: string[];
  erro: string | null;
  quando: string;
  gateway: string | null;
  valorCents: number | null;
  atribuicao: string | null;
}

export async function ultimosDisparos(p: Periodo, limite = 40): Promise<Disparo[]> {
  const linhas = await linhasDe(db.execute<{
    id: string; evento: string; event_id: string; estado: string;
    chaves: string[] | null; erro: string | null; quando: string;
    gateway: string | null; valor: number | null; atribuicao: string | null;
  }>(sql`
    SELECT d.id, d.event_name AS evento, d.event_id, d.status::text AS estado,
      d.match_keys AS chaves, d.error AS erro,
      to_char(d.created_at AT TIME ZONE ${p.timezone}, 'DD/MM HH24:MI') AS quando,
      gc.gateway,
      o.gross_cents AS valor,
      o.attribution_method AS atribuicao
    FROM dispatches d
    LEFT JOIN orders o ON o.id = d.order_id
    LEFT JOIN gateway_connections gc ON gc.id = o.gateway_connection_id
    WHERE d.tenant_id = ${p.tenantId}
      AND (d.created_at AT TIME ZONE ${p.timezone})::date BETWEEN ${p.de}::date AND ${p.ate}::date
    ORDER BY d.created_at DESC
    LIMIT ${limite}
  `));

  return linhas.map((l) => ({
    id: l.id,
    evento: l.evento,
    eventId: l.event_id,
    estado: l.estado,
    chaves: Array.isArray(l.chaves) ? l.chaves : [],
    erro: l.erro,
    quando: l.quando,
    gateway: l.gateway,
    valorCents: l.valor === null ? null : Number(l.valor),
    atribuicao: l.atribuicao,
  }));
}

/* --------------------------------------------------------------- UTMs -- */

export interface LinhaUtm {
  fonte: string;
  meio: string;
  campanha: string;
  conteudo: string;
  sessoes: number;
  vendas: number;
  faturamentoCents: number;
  taxaConversao: number | null;
}

export async function porUtm(p: Periodo, agrupar: "fonte" | "campanha" | "conteudo"): Promise<LinhaUtm[]> {
  /*
   * O nível de agrupamento muda quais colunas entram no GROUP BY. Agrupar por
   * conteúdo sem incluir campanha juntaria dois criativos de nome igual em
   * campanhas diferentes — que acontece o tempo todo, porque criativo se chama
   * "v1" em toda campanha.
   */
  /*
   * Agrupa pelas posições do SELECT, e só pelas que carregam valor de verdade.
   * As posições não usadas no nível pedido vêm como texto vazio no SELECT, e o
   * Postgres recusa agrupar por constante — mas não precisa: constante é
   * funcionalmente dependente de qualquer agrupamento.
   */
  const grupo = agrupar === "fonte"
    ? sql`1, 2`
    : agrupar === "campanha"
      ? sql`1, 2, 3`
      : sql`1, 2, 3, 4`;

  const linhas = await linhasDe(db.execute<{
    fonte: string; meio: string; campanha: string; conteudo: string;
    sessoes: number; vendas: number; faturamento: number;
  }>(sql`
    SELECT
      coalesce(nullif(cs.utm_source, ''), '(direto)') AS fonte,
      coalesce(cs.utm_medium, '') AS meio,
      ${agrupar === "fonte" ? sql`''` : sql`coalesce(cs.campaign_name, cs.campaign_id, '')`} AS campanha,
      ${agrupar === "conteudo" ? sql`coalesce(cs.ad_name, cs.ad_id, '')` : sql`''`} AS conteudo,
      count(DISTINCT cs.click_id)::int AS sessoes,
      count(o.id) FILTER (WHERE o.status = 'paid')::int AS vendas,
      coalesce(sum(o.gross_cents) FILTER (WHERE o.status = 'paid'), 0)::bigint AS faturamento
    FROM click_sessions cs
    LEFT JOIN orders o ON o.click_id = cs.click_id AND o.tenant_id = cs.tenant_id
    WHERE cs.tenant_id = ${p.tenantId}
      AND (cs.first_seen_at AT TIME ZONE ${p.timezone})::date BETWEEN ${p.de}::date AND ${p.ate}::date
    GROUP BY ${grupo}
    ORDER BY faturamento DESC, sessoes DESC
    LIMIT 100
  `));

  return linhas.map((l) => ({
    fonte: l.fonte,
    meio: l.meio,
    campanha: l.campanha,
    conteudo: l.conteudo,
    sessoes: Number(l.sessoes),
    vendas: Number(l.vendas),
    faturamentoCents: Number(l.faturamento),
    taxaConversao: Number(l.sessoes) ? (Number(l.vendas) / Number(l.sessoes)) * 100 : null,
  }));
}
