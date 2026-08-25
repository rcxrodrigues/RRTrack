/*
 * O cruzamento: gasto de um lado, venda do outro, no mesmo nível.
 *
 * Três fontes que não se conhecem, unidas pelo id da estrutura do anúncio:
 *
 *   ad_spend_daily   gasto, impressões e cliques, vindos da API da plataforma
 *   orders           vendas, via click_sessions, que carrega o ad_id da UTM
 *   events           iniciar checkout, pelo mesmo caminho
 *
 * O `IC` merece nota: ele NÃO vem da plataforma. É a contagem do nosso próprio
 * rastreamento amarrada à estrutura do anúncio, e por isso é mais confiável que
 * o número que a plataforma reporta — a janela de atribuição é a nossa, não a
 * dela.
 *
 * Toda divisão devolve `null` quando o denominador é zero, e o painel mostra
 * N/A. É deliberado: ROAS zero e ROAS incalculável são coisas diferentes.
 * Campanha que gastou e não vendeu tem ROAS zero; campanha que não gastou não
 * tem ROAS nenhum, e escrever "0,00" ali sugere um fracasso que não houve.
 */

import { and, between, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "../db/index";
import { adSpendDaily, clickSessions, events, orders } from "../db/schema";

export type Nivel = "conta" | "campanha" | "conjunto" | "anuncio";

export interface LinhaMetrica {
  id: string;
  nome: string;

  /* Da plataforma */
  gastoCents: number;
  impressoes: number;
  cliques: number;

  /* Nosso */
  vendas: number;
  faturamentoCents: number;
  custoProdutoCents: number;
  ic: number;

  /* Derivados — null quando não dá para calcular */
  lucroCents: number;
  roas: number | null;
  roi: number | null;
  margem: number | null;
  cpaCents: number | null;
  cpiCents: number | null;
  cpcCents: number | null;
  ctr: number | null;
  cpmCents: number | null;

  /*
   * Quando o gasto desta linha foi buscado pela última vez. Em milissegundos
   * para atravessar a fronteira servidor→cliente sem virar string e voltar.
   * Serve para o operador saber se está olhando número fresco ou de uma hora
   * atrás — diferença que decide se vale agir agora ou esperar.
   */
  atualizadoEmMs: number | null;
}

/** Divisão que admite não ter resposta. */
function dividir(a: number, b: number): number | null {
  return b === 0 ? null : a / b;
}

const COLUNA: Record<Nivel, { id: AnyPgColumn; nome: AnyPgColumn }> = {
  conta: { id: adSpendDaily.adAccountId, nome: adSpendDaily.platform },
  campanha: { id: adSpendDaily.campaignId, nome: adSpendDaily.campaignName },
  conjunto: { id: adSpendDaily.adsetId, nome: adSpendDaily.adsetName },
  anuncio: { id: adSpendDaily.adId, nome: adSpendDaily.adName },
};

/*
 * Por qual coluna da sessão as vendas se agrupam, em cada nível.
 *
 * Campanha, conjunto e anúncio têm coluna equivalente na sessão, porque a UTM
 * carrega os três ids. Conta não tem: a plataforma não põe o id da conta de
 * anúncio na URL, e não há de onde a sessão saber a que conta o clique
 * pertence.
 *
 * Por isso conta agrupa por anúncio aqui e é somada depois, usando o mapa
 * anúncio→conta que o próprio gasto fornece. Cruzar direto o id da conta com
 * o id do anúncio — que é o que este arquivo fazia — não casa nunca: toda
 * venda sumia no nível de conta, e a aba mostrava prejuízo em tudo.
 */
const SESSAO: Record<Nivel, AnyPgColumn> = {
  conta: clickSessions.adId,
  campanha: clickSessions.campaignId,
  conjunto: clickSessions.adsetId,
  anuncio: clickSessions.adId,
};

export interface Filtro {
  tenantId: string;
  plataforma: string;
  /** AAAA-MM-DD, inclusivas. */
  de: string;
  ate: string;
  nivel: Nivel;
  /** Filtra por parte do nome, como o campo de busca da tela. */
  nome?: string;
}

export async function metricas(f: Filtro): Promise<LinhaMetrica[]> {
  const colId = COLUNA[f.nivel].id;
  const colNome = COLUNA[f.nivel].nome;
  const colSessao = SESSAO[f.nivel];

  /*
   * As datas de venda vêm como instante, e as de gasto como dia no fuso da
   * conta. Comparar os dois exige uma borda: usamos o dia inteiro em UTC, o
   * que basta enquanto conta e loja estiverem no mesmo fuso. Quando divergirem,
   * é aqui que a conversão entra — e o aviso da sincronização avisa antes.
   */
  const inicio = new Date(f.de + "T00:00:00.000Z");
  const fim = new Date(f.ate + "T23:59:59.999Z");

  /* -------------------------------------------------- gasto por nível -- */
  const gastos = await db
    .select({
      id: colId,
      nome: sql<string>`max(${colNome})`,
      gasto: sql<number>`coalesce(sum(${adSpendDaily.spendCents}), 0)::int`,
      impressoes: sql<number>`coalesce(sum(${adSpendDaily.impressions}), 0)::int`,
      cliques: sql<number>`coalesce(sum(${adSpendDaily.clicks}), 0)::int`,
      atualizadoEm: sql<string | null>`max(${adSpendDaily.syncedAt})`,
    })
    .from(adSpendDaily)
    .where(and(
      eq(adSpendDaily.tenantId, f.tenantId),
      eq(adSpendDaily.platform, f.plataforma),
      between(adSpendDaily.date, f.de, f.ate),
      isNotNull(colId),
    ))
    .groupBy(colId);

  /* ------------------------------------------------- vendas por nível -- */
  const vendas = await db
    .select({
      id: colSessao,
      quantidade: sql<number>`count(*)::int`,
      faturamento: sql<number>`coalesce(sum(${orders.grossCents}), 0)::int`,
      custo: sql<number>`coalesce(sum(${orders.cogsCents}), 0)::int`,
    })
    .from(orders)
    .innerJoin(clickSessions, eq(clickSessions.clickId, orders.clickId))
    .where(and(
      eq(orders.tenantId, f.tenantId),
      eq(orders.status, "paid"),
      between(orders.occurredAt, inicio, fim),
      isNotNull(colSessao),
    ))
    .groupBy(colSessao);

  /* ------------------------------------ iniciar checkout, do nosso lado */
  const ics = await db
    .select({
      id: colSessao,
      quantidade: sql<number>`count(*)::int`,
    })
    .from(events)
    .innerJoin(clickSessions, eq(clickSessions.clickId, events.clickId))
    .where(and(
      eq(events.tenantId, f.tenantId),
      inArray(events.name, ["begin_checkout", "initiate_checkout", "open_cart"]),
      between(events.occurredAt, inicio, fim),
      isNotNull(colSessao),
    ))
    .groupBy(colSessao);

  /*
   * No nível de conta, as vendas vieram agrupadas por anúncio e ainda precisam
   * subir para a conta. O próprio gasto diz a que conta cada anúncio pertence —
   * é a única fonte que sabe, já que a sessão nunca soube.
   */
  let paraConta: Map<string, string> | null = null;
  if (f.nivel === "conta") {
    const pares = await db
      .selectDistinct({ adId: adSpendDaily.adId, conta: adSpendDaily.adAccountId })
      .from(adSpendDaily)
      .where(and(
        eq(adSpendDaily.tenantId, f.tenantId),
        eq(adSpendDaily.platform, f.plataforma),
        between(adSpendDaily.date, f.de, f.ate),
        isNotNull(adSpendDaily.adId),
      ));

    paraConta = new Map(
      pares.filter((p): p is { adId: string; conta: string } => !!p.adId).map((p) => [p.adId, p.conta]),
    );
  }

  /*
   * Traduz a chave de agrupamento e soma o que cair na mesma. Fora do nível de
   * conta, `paraConta` é nulo e isto é uma cópia fiel do que veio do banco.
   */
  function agrupar<T extends { id: string | null }>(
    linhas: T[],
    somar: (a: T, b: T) => T,
  ): Map<string, T> {
    const m = new Map<string, T>();
    for (const l of linhas) {
      const chave = paraConta ? (l.id ? paraConta.get(l.id) : undefined) : l.id;
      /* Anúncio sem gasto no período não tem conta conhecida; fica de fora. */
      if (!chave) continue;
      const atual = m.get(chave);
      m.set(chave, atual ? somar(atual, l) : { ...l, id: chave });
    }
    return m;
  }

  const porVenda = agrupar(vendas, (a, b) => ({
    ...a,
    quantidade: a.quantidade + b.quantidade,
    faturamento: a.faturamento + b.faturamento,
    custo: a.custo + b.custo,
  }));

  const porIcAgrupado = agrupar(ics, (a, b) => ({
    ...a,
    quantidade: a.quantidade + b.quantidade,
  }));
  const porIc = new Map([...porIcAgrupado].map(([k, v]) => [k, v.quantidade]));

  /*
   * A base é o gasto, não a venda. Uma campanha que gastou e não vendeu
   * PRECISA aparecer — é justamente a que se quer ver. Partir das vendas
   * esconderia exatamente o prejuízo que o painel existe para mostrar.
   */
  const linhas: LinhaMetrica[] = gastos.map((g) => {
    const id = g.id ?? "";
    const v = porVenda.get(id);
    const faturamento = v?.faturamento ?? 0;
    const custoProduto = v?.custo ?? 0;
    const gasto = g.gasto;
    const ic = porIc.get(id) ?? 0;

    /*
     * Lucro desconta o custo do produto quando ele é conhecido. Quando não é,
     * o número aqui é margem de contribuição sobre o anúncio, não lucro final —
     * e a tela precisa dizer isso, senão vira otimismo disfarçado de dado.
     */
    const lucro = faturamento - gasto - custoProduto;

    return {
      id,
      nome: g.nome ?? id,
      gastoCents: gasto,
      impressoes: g.impressoes,
      cliques: g.cliques,
      vendas: v?.quantidade ?? 0,
      faturamentoCents: faturamento,
      custoProdutoCents: custoProduto,
      ic,
      lucroCents: lucro,
      roas: dividir(faturamento, gasto),
      roi: dividir(lucro, gasto),
      margem: dividir(lucro, faturamento),
      cpaCents: v?.quantidade ? Math.round(gasto / v.quantidade) : null,
      cpiCents: ic ? Math.round(gasto / ic) : null,
      cpcCents: g.cliques ? Math.round(gasto / g.cliques) : null,
      ctr: dividir(g.cliques, g.impressoes),
      cpmCents: g.impressoes ? Math.round((gasto / g.impressoes) * 1000) : null,
      atualizadoEmMs: g.atualizadoEm ? new Date(g.atualizadoEm).getTime() : null,
    };
  });

  const filtradas = f.nome
    ? linhas.filter((l) => l.nome.toLowerCase().includes(f.nome!.toLowerCase()))
    : linhas;

  /* Maior gasto primeiro: é onde há mais dinheiro em jogo e mais a decidir. */
  return filtradas.sort((a, b) => b.gastoCents - a.gastoCents);
}

/** Soma as linhas para a faixa de total do rodapé. */
export function totalizar(linhas: LinhaMetrica[]): LinhaMetrica {
  const s = (f: (l: LinhaMetrica) => number) => linhas.reduce((t, l) => t + f(l), 0);

  const gasto = s((l) => l.gastoCents);
  const faturamento = s((l) => l.faturamentoCents);
  const custo = s((l) => l.custoProdutoCents);
  const impressoes = s((l) => l.impressoes);
  const cliques = s((l) => l.cliques);
  const vendas = s((l) => l.vendas);
  const ic = s((l) => l.ic);
  const lucro = faturamento - gasto - custo;

  return {
    id: "__total__",
    nome: `${linhas.length} ${linhas.length === 1 ? "item" : "itens"}`,
    gastoCents: gasto,
    impressoes, cliques, vendas,
    faturamentoCents: faturamento,
    custoProdutoCents: custo,
    ic,
    lucroCents: lucro,
    /*
     * O total recalcula a partir das somas em vez de somar as razões. Média de
     * ROAS não é o ROAS do total: uma campanha com ROAS 10 que gastou dez reais
     * não compensa uma com ROAS 1 que gastou dez mil.
     */
    roas: dividir(faturamento, gasto),
    roi: dividir(lucro, gasto),
    margem: dividir(lucro, faturamento),
    cpaCents: vendas ? Math.round(gasto / vendas) : null,
    cpiCents: ic ? Math.round(gasto / ic) : null,
    cpcCents: cliques ? Math.round(gasto / cliques) : null,
    ctr: dividir(cliques, impressoes),
    cpmCents: impressoes ? Math.round((gasto / impressoes) * 1000) : null,

    /*
     * O total mostra a atualização MAIS ANTIGA, não a mais recente.
     *
     * Se uma conta sincronizou agora e outra há três horas, o número somado tem
     * três horas de idade — é tão fresco quanto sua parte mais velha. Mostrar a
     * mais recente diria que o total está atualizado quando metade dele não está.
     */
    atualizadoEmMs: linhas.reduce<number | null>((menor, l) => {
      if (l.atualizadoEmMs === null) return menor;
      return menor === null ? l.atualizadoEmMs : Math.min(menor, l.atualizadoEmMs);
    }, null),
  };
}
