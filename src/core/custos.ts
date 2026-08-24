/*
 * Custo dos produtos, e como ele entra no lucro.
 *
 * Sem isto, o que o painel chama de lucro é margem de contribuição sobre o
 * anúncio: faturamento menos gasto de mídia. Parece lucro, cresce como lucro,
 * e some quando chega a nota do fornecedor.
 *
 * O custo tem VIGÊNCIA, e essa é a decisão que não é óbvia. Guardar um único
 * custo por SKU faria o lucro do mês passado se reescrever sozinho quando o
 * fornecedor reajustasse — o histórico mudaria sem nada ter acontecido no
 * passado. Cada pedido usa o custo que valia no dia em que ele aconteceu.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index";
import { orderItems, orders, productCosts } from "../db/schema";

async function linhasDe<T>(consulta: Promise<{ rows: T[] }>): Promise<T[]> {
  return (await consulta).rows;
}

export interface CustoDeSku {
  sku: string;
  /** Custo vigente hoje. `null` quando nunca foi cadastrado. */
  custoCents: number | null;
  desde: string | null;
  /* Quanto este SKU vendeu, para dar contexto ao cadastrar. */
  vendas: number;
  faturamentoCents: number;
  /** Quantas versões de custo já existiram. */
  versoes: number;
}

/**
 * Todos os SKUs que já venderam, com o custo vigente de cada um.
 *
 * A lista sai das VENDAS, não do cadastro de custos. Assim os produtos que
 * faltam preencher aparecem sozinhos, em vez de o lojista ter que lembrar
 * quais são — e o que falta preencher é justamente o que distorce o lucro.
 */
export async function skusComCusto(tenantId: string): Promise<CustoDeSku[]> {
  const linhas = await linhasDe(db.execute<{
    sku: string; custo: number | null; desde: string | null;
    vendas: number; faturamento: number; versoes: number;
  }>(sql`
    WITH vendidos AS (
      SELECT oi.sku,
        count(*)::int AS vendas,
        coalesce(sum(oi.unit_price_cents * oi.quantity), 0)::bigint AS faturamento
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE oi.tenant_id = ${tenantId} AND o.status = 'paid' AND oi.sku IS NOT NULL
      GROUP BY oi.sku
    ),
    vigente AS (
      SELECT DISTINCT ON (sku) sku, unit_cost_cents, effective_from
      FROM product_costs
      WHERE tenant_id = ${tenantId} AND effective_from <= now()
      ORDER BY sku, effective_from DESC
    ),
    contagem AS (
      SELECT sku, count(*)::int AS versoes FROM product_costs
      WHERE tenant_id = ${tenantId} GROUP BY sku
    )
    SELECT
      coalesce(v.sku, g.sku) AS sku,
      g.unit_cost_cents AS custo,
      to_char(g.effective_from, 'DD/MM/YYYY') AS desde,
      coalesce(v.vendas, 0)::int AS vendas,
      coalesce(v.faturamento, 0)::bigint AS faturamento,
      coalesce(c.versoes, 0)::int AS versoes
    FROM vendidos v
    FULL OUTER JOIN vigente g ON g.sku = v.sku
    LEFT JOIN contagem c ON c.sku = coalesce(v.sku, g.sku)
    ORDER BY coalesce(v.faturamento, 0) DESC, coalesce(v.sku, g.sku)
  `));

  return linhas.map((l) => ({
    sku: l.sku,
    custoCents: l.custo === null ? null : Number(l.custo),
    desde: l.desde,
    vendas: Number(l.vendas),
    faturamentoCents: Number(l.faturamento),
    versoes: Number(l.versoes),
  }));
}

/**
 * Aplica os custos vigentes a uma venda recém-gravada.
 *
 * Roda depois de o pedido e os itens entrarem. Cada item busca o custo que
 * valia na data do PEDIDO, não hoje — é isso que impede o histórico de mudar
 * quando o fornecedor reajusta.
 *
 * Devolve o custo total, ou `null` quando nenhum item tem custo cadastrado.
 * Zero seria mentira: significaria "custa nada", e o que se quer dizer é "não
 * se sabe".
 */
export async function aplicarCustos(
  tenantId: string,
  orderId: string,
  quando: Date,
): Promise<number | null> {
  const linhas = await linhasDe(db.execute<{ id: string; custo: number | null; quantidade: number }>(sql`
    SELECT oi.id,
      (SELECT pc.unit_cost_cents FROM product_costs pc
        WHERE pc.tenant_id = ${tenantId}
          AND pc.sku = oi.sku
          AND pc.effective_from <= ${quando}
        ORDER BY pc.effective_from DESC
        LIMIT 1) AS custo,
      oi.quantity AS quantidade
    FROM order_items oi
    WHERE oi.order_id = ${orderId} AND oi.sku IS NOT NULL
  `));

  let total = 0;
  let algum = false;

  for (const l of linhas) {
    if (l.custo === null) continue;
    algum = true;
    const unitario = Number(l.custo);
    total += unitario * Number(l.quantidade);
    await db.update(orderItems)
      .set({ unitCostCents: unitario })
      .where(eq(orderItems.id, l.id));
  }

  if (!algum) return null;

  await db.update(orders).set({ cogsCents: total }).where(eq(orders.id, orderId));
  return total;
}

/**
 * Recalcula o custo de vendas já gravadas.
 *
 * Serve para o dia em que o lojista cadastra o custo pela primeira vez, depois
 * de já ter vendido: sem isto, todo o histórico ficaria sem custo para sempre,
 * e só as vendas futuras teriam lucro correto.
 */
export async function recalcular(tenantId: string, sku?: string): Promise<number> {
  const alvos = await db
    .select({ id: orders.id, quando: orders.occurredAt })
    .from(orders)
    .where(and(
      eq(orders.tenantId, tenantId),
      eq(orders.status, "paid"),
      ...(sku
        ? [sql`EXISTS (SELECT 1 FROM ${orderItems} oi WHERE oi.order_id = ${orders.id} AND oi.sku = ${sku})`]
        : []),
    ));

  let mexidos = 0;
  for (const o of alvos) {
    const r = await aplicarCustos(tenantId, o.id, o.quando);
    if (r !== null) mexidos++;
  }
  return mexidos;
}
