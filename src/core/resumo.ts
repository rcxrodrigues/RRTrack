/*
 * As consultas do Resumo.
 *
 * Tudo aqui sai dos NOSSOS dados — vendas, eventos, sessões de clique. A única
 * peça que depende de plataforma externa é o gasto, e ela está isolada de
 * propósito: sem conta de anúncio conectada, o painel perde ROAS e lucro sobre
 * anúncio, mas continua mostrando faturamento, funil e horário.
 *
 * O fuso é o da loja, não UTC. "Vendas por horário" em UTC mostraria o pico das
 * 21h brasileiras como meia-noite, e o corte do dia cairia às 21h — o dia de
 * ontem continuaria recebendo venda enquanto o lojista já dormiu.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/index";
import { REGRA_PADRAO, valorCru, type RegraFaturamento } from "./faturamento";

/*
 * O driver HTTP da Neon devolve `{ rows }`, e não a lista direto — diferente
 * do driver TCP. Este atalho isola a diferença num lugar só, para trocar de
 * driver um dia não virar caçada por todo o arquivo.
 */
async function linhasDe<T>(consulta: Promise<{ rows: T[] }>): Promise<T[]> {
  return (await consulta).rows;
}

export interface Periodo {
  tenantId: string;
  /* O que a loja conta como faturamento — ver core/faturamento.ts. */
  regra?: RegraFaturamento;
  de: string;   /* AAAA-MM-DD, no fuso da loja */
  ate: string;
  timezone: string;
}

/* ------------------------------------------------------------ números -- */

export interface Indicadores {
  faturamentoBrutoCents: number;
  faturamentoLiquidoCents: number;
  taxasCents: number;
  reembolsosCents: number;
  custoProdutoCents: number;
  gastoCents: number;
  lucroCents: number;
  vendasAprovadas: number;
  vendasPendentes: number;
  pendenteCents: number;
  reembolsadas: number;
  ticketMedioCents: number | null;
  roas: number | null;
  margem: number | null;
  cpaCents: number | null;
}

export async function indicadores(p: Periodo): Promise<Indicadores> {
  const v = valorCru(p.regra ?? REGRA_PADRAO);
  const [linha] = await linhasDe(db.execute<{
    bruto: number; taxas: number; custo: number; aprovadas: number;
    pendentes: number; pendente_valor: number; reembolsos: number; reembolsadas: number;
  }>(sql`
    SELECT
      coalesce(sum(${v})            filter (where status = 'paid'), 0)::bigint AS bruto,
      coalesce(sum(fee_cents)        filter (where status = 'paid'), 0)::bigint AS taxas,
      coalesce(sum(cogs_cents)       filter (where status = 'paid'), 0)::bigint AS custo,
      count(*)                       filter (where status = 'paid')::int        AS aprovadas,
      count(*)                       filter (where status = 'pending')::int     AS pendentes,
      coalesce(sum(${v})            filter (where status = 'pending'), 0)::bigint AS pendente_valor,
      coalesce(sum(${v})            filter (where status in ('refunded','chargeback')), 0)::bigint AS reembolsos,
      count(*)                       filter (where status in ('refunded','chargeback'))::int AS reembolsadas
    FROM orders
    WHERE tenant_id = ${p.tenantId}
      AND (occurred_at AT TIME ZONE ${p.timezone})::date BETWEEN ${p.de}::date AND ${p.ate}::date
  `));

  const [g] = await linhasDe(db.execute<{ gasto: number }>(sql`
    SELECT coalesce(sum(spend_cents), 0)::bigint AS gasto
    FROM ad_spend_daily
    WHERE tenant_id = ${p.tenantId} AND date BETWEEN ${p.de} AND ${p.ate}
  `));

  const bruto = Number(linha?.bruto ?? 0);
  const taxas = Number(linha?.taxas ?? 0);
  const custo = Number(linha?.custo ?? 0);
  const reembolsos = Number(linha?.reembolsos ?? 0);
  const gasto = Number(g?.gasto ?? 0);
  const aprovadas = Number(linha?.aprovadas ?? 0);

  /*
   * Líquido desconta o que não fica com você: taxa do gateway e o que voltou.
   * É o número que serve para decidir; o bruto serve para conferir com o extrato.
   */
  const liquido = bruto - taxas - reembolsos;
  const lucro = liquido - custo - gasto;

  return {
    faturamentoBrutoCents: bruto,
    faturamentoLiquidoCents: liquido,
    taxasCents: taxas,
    reembolsosCents: reembolsos,
    custoProdutoCents: custo,
    gastoCents: gasto,
    lucroCents: lucro,
    vendasAprovadas: aprovadas,
    vendasPendentes: Number(linha?.pendentes ?? 0),
    pendenteCents: Number(linha?.pendente_valor ?? 0),
    reembolsadas: Number(linha?.reembolsadas ?? 0),
    ticketMedioCents: aprovadas ? Math.round(bruto / aprovadas) : null,
    roas: gasto ? liquido / gasto : null,
    /*
     * Em pontos percentuais (0 a 100), como toda taxa deste módulo — a do
     * funil e a de aprovação também multiplicam por 100. Devolver a proporção
     * crua aqui fazia a tela mostrar "0,3%" onde havia 27% de margem, porque o
     * formatador de porcentagem da interface só acrescenta o símbolo.
     */
    margem: liquido ? (lucro / liquido) * 100 : null,
    cpaCents: aprovadas && gasto ? Math.round(gasto / aprovadas) : null,
  };
}

/* -------------------------------------------------------------- funil -- */

export interface EtapaFunil {
  rotulo: string;
  valor: number;
  /* Passagem desde a etapa anterior. `null` no topo, que não tem anterior. */
  taxa: number | null;
  perda: number;
}

export async function funil(p: Periodo): Promise<EtapaFunil[]> {
  const linhas = await linhasDe(db.execute<{ nome: string; n: number }>(sql`
    SELECT name AS nome, count(DISTINCT click_id)::int AS n
    FROM events
    WHERE tenant_id = ${p.tenantId}
      AND (occurred_at AT TIME ZONE ${p.timezone})::date BETWEEN ${p.de}::date AND ${p.ate}::date
    GROUP BY name
  `));

  const [vendas] = await linhasDe(db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM orders
    WHERE tenant_id = ${p.tenantId} AND status = 'paid'
      AND (occurred_at AT TIME ZONE ${p.timezone})::date BETWEEN ${p.de}::date AND ${p.ate}::date
  `));

  /*
   * Conta VISITANTES, não eventos: `count(distinct click_id)`. Contar eventos
   * faria quem recarrega a página três vezes virar três visitantes, e a taxa
   * de passagem despencaria sem que nada tivesse piorado.
   */
  const por = (nomes: string[]) =>
    linhas.filter((l) => nomes.includes(l.nome)).reduce((s, l) => s + Number(l.n), 0);

  const etapas = [
    { rotulo: "Visitou o site", valor: por(["page_view"]) },
    { rotulo: "Viu o produto", valor: por(["view_item", "view_content", "product_view"]) },
    { rotulo: "Adicionou ao carrinho", valor: por(["add_to_cart", "view_cart"]) },
    { rotulo: "Iniciou o checkout", valor: por(["begin_checkout", "initiate_checkout", "open_cart"]) },
    { rotulo: "Comprou", valor: Number(vendas?.n ?? 0) },
  ];

  return etapas.map((e, i) => {
    const ant = i === 0 ? null : etapas[i - 1]!.valor;
    return {
      ...e,
      taxa: ant ? (ant === 0 ? null : (e.valor / ant) * 100) : null,
      perda: ant ? Math.max(0, ant - e.valor) : 0,
    };
  });
}

/* ------------------------------------------------------------ horário -- */

export interface Celula { dia: number; hora: number; vendas: number; valorCents: number }

export async function porHorario(p: Periodo): Promise<Celula[]> {
  const v = valorCru(p.regra ?? REGRA_PADRAO);
  const linhas = await linhasDe(db.execute<{ dia: number; hora: number; n: number; valor: number }>(sql`
    SELECT
      EXTRACT(DOW  FROM (occurred_at AT TIME ZONE ${p.timezone}))::int AS dia,
      EXTRACT(HOUR FROM (occurred_at AT TIME ZONE ${p.timezone}))::int AS hora,
      count(*)::int AS n,
      coalesce(sum(${v}), 0)::bigint AS valor
    FROM orders
    WHERE tenant_id = ${p.tenantId} AND status = 'paid'
      AND (occurred_at AT TIME ZONE ${p.timezone})::date BETWEEN ${p.de}::date AND ${p.ate}::date
    GROUP BY 1, 2
  `));

  return linhas.map((l) => ({
    /* Postgres conta o domingo como 0; a tela começa na segunda. */
    dia: (Number(l.dia) + 6) % 7,
    hora: Number(l.hora),
    vendas: Number(l.n),
    valorCents: Number(l.valor),
  }));
}

/* ------------------------------------------------------------- origem -- */

export interface Origem {
  fonte: string;
  sessoes: number;
  vendas: number;
  faturamentoCents: number;
}

export async function porOrigem(p: Periodo): Promise<Origem[]> {
  const v = valorCru(p.regra ?? REGRA_PADRAO, "o");
  const linhas = await linhasDe(db.execute<{
    fonte: string; sessoes: number; vendas: number; faturamento: number;
  }>(sql`
    SELECT
      coalesce(nullif(cs.utm_source, ''), '(direto)')
        || coalesce(' / ' || nullif(cs.utm_medium, ''), '') AS fonte,
      count(DISTINCT cs.click_id)::int AS sessoes,
      count(o.id) FILTER (WHERE o.status = 'paid')::int AS vendas,
      coalesce(sum(${v}) FILTER (WHERE o.status = 'paid'), 0)::bigint AS faturamento
    FROM click_sessions cs
    LEFT JOIN orders o ON o.click_id = cs.click_id AND o.tenant_id = cs.tenant_id
    WHERE cs.tenant_id = ${p.tenantId}
      AND (cs.first_seen_at AT TIME ZONE ${p.timezone})::date BETWEEN ${p.de}::date AND ${p.ate}::date
    GROUP BY 1
    ORDER BY faturamento DESC, sessoes DESC
    LIMIT 12
  `));

  return linhas.map((l) => ({
    fonte: l.fonte,
    sessoes: Number(l.sessoes),
    vendas: Number(l.vendas),
    faturamentoCents: Number(l.faturamento),
  }));
}

/* ----------------------------------------------------------- regiao -- */

export interface Regiao {
  pais: string | null;
  regiao: string | null;
  sessoes: number;
  vendas: number;
  faturamentoCents: number;
}

/*
 * De onde veio o tráfego no período escolhido.
 *
 * Não confundir com a seção "ao vivo", que mostra a última hora e no máximo
 * doze linhas. Ela responde "quem está aqui agora"; esta responde "de onde
 * vieram meus acessos e minhas vendas hoje" — e a diferença aparece já no
 * primeiro dia de tráfego, quando dezoito estados acessaram e a seção ao vivo
 * mostrava três, porque os outros quinze tinham entrado antes da última hora.
 *
 * Agrupa por estado e não por cidade de propósito. Cidade é granular demais
 * para decidir alguma coisa: cinquenta linhas com uma sessão cada não dizem
 * nada, e é o estado que casa com a segmentação geográfica do gerenciador.
 */
export async function porRegiao(p: Periodo): Promise<Regiao[]> {
  const v = valorCru(p.regra ?? REGRA_PADRAO, "o");
  const linhas = await linhasDe(db.execute<{
    pais: string | null; regiao: string | null;
    sessoes: number; vendas: number; faturamento: number;
  }>(sql`
    SELECT
      cs.country AS pais,
      cs.region  AS regiao,
      count(DISTINCT cs.click_id)::int AS sessoes,
      count(o.id) FILTER (WHERE o.status = 'paid')::int AS vendas,
      coalesce(sum(${v}) FILTER (WHERE o.status = 'paid'), 0)::bigint AS faturamento
    FROM click_sessions cs
    LEFT JOIN orders o ON o.click_id = cs.click_id AND o.tenant_id = cs.tenant_id
    WHERE cs.tenant_id = ${p.tenantId}
      AND (cs.first_seen_at AT TIME ZONE ${p.timezone})::date BETWEEN ${p.de}::date AND ${p.ate}::date
    GROUP BY cs.country, cs.region
    ORDER BY sessoes DESC, faturamento DESC
    LIMIT 40
  `));

  return linhas.map((l) => ({
    pais: l.pais,
    regiao: l.regiao,
    sessoes: Number(l.sessoes),
    vendas: Number(l.vendas),
    faturamentoCents: Number(l.faturamento),
  }));
}

/* --------------------------------------------------------- pagamento -- */

export interface Aprovacao { metodo: string; aprovadas: number; total: number; taxa: number | null }

export async function porPagamento(p: Periodo): Promise<Aprovacao[]> {
  const linhas = await linhasDe(db.execute<{ metodo: string; aprovadas: number; total: number }>(sql`
    SELECT payment_method::text AS metodo,
      count(*) FILTER (WHERE status = 'paid')::int AS aprovadas,
      count(*)::int AS total
    FROM orders
    WHERE tenant_id = ${p.tenantId}
      AND (occurred_at AT TIME ZONE ${p.timezone})::date BETWEEN ${p.de}::date AND ${p.ate}::date
    GROUP BY 1
    ORDER BY total DESC
  `));

  const nomes: Record<string, string> = {
    pix: "Pix", credit_card: "Cartão de crédito", debit_card: "Cartão de débito",
    boleto: "Boleto", wallet: "Carteira", other: "Outro",
  };

  return linhas.map((l) => ({
    metodo: nomes[l.metodo] ?? l.metodo,
    aprovadas: Number(l.aprovadas),
    total: Number(l.total),
    taxa: Number(l.total) ? (Number(l.aprovadas) / Number(l.total)) * 100 : null,
  }));
}
