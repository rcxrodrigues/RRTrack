/*
 * Custo de produto com vigência.
 *
 * A parte sutil é a data. Guardar um custo por SKU faria o lucro do mês passado
 * se reescrever sozinho quando o fornecedor reajustasse — o histórico mudaria
 * sem nada ter acontecido no passado. Cada pedido usa o custo que valia no dia
 * em que ele aconteceu, e é isso que estes testes provam.
 *
 * Compilar antes:
 *   npx tsc src/core/custos.ts --outDir _tmp --target ES2022 \
 *     --module commonjs --moduleResolution node --skipLibCheck --esModuleInterop --strict
 *   echo {"type":"commonjs"} > _tmp/package.json
 *   node scripts/teste-custos.cjs
 */
const { neon } = require("@neondatabase/serverless");
const { webcrypto: wc } = require("node:crypto");
process.loadEnvFile(".env");
const sql = neon(process.env.DATABASE_URL);
const { aplicarCustos, skusComCusto, recalcular } = require("../_tmp/core/custos.js");

let f = 0;
const eq = (l, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  if (!ok) f++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${l}` + (ok ? "" : `  obtido ${JSON.stringify(g)}, esperado ${JSON.stringify(w)}`));
};

(async () => {
  await sql`DELETE FROM tenants WHERE slug = 'custo-teste'`;
  const [t] = await sql`INSERT INTO tenants (name, slug) VALUES ('C', 'custo-teste') RETURNING id`;
  const [conn] = await sql`INSERT INTO gateway_connections (tenant_id, gateway, label, webhook_secret)
    VALUES (${t.id}, 'pagou', 'P', ${"ws" + Date.now()}) RETURNING id`;

  const criarVenda = async (quando, itens) => {
    const [o] = await sql`INSERT INTO orders (tenant_id, gateway_connection_id, gateway_order_id, status, gross_cents, attribution_method, occurred_at)
      VALUES (${t.id}, ${conn.id}, ${"o" + wc.randomUUID()}, 'paid',
        ${itens.reduce((s, i) => s + i.preco * i.qtd, 0)}, 'click_id', ${quando}) RETURNING id`;
    for (const i of itens) {
      await sql`INSERT INTO order_items (order_id, tenant_id, sku, name, quantity, unit_price_cents)
        VALUES (${o.id}, ${t.id}, ${i.sku}, ${i.sku}, ${i.qtd}, ${i.preco})`;
    }
    return o.id;
  };

  /* Duas vendas do mesmo produto, em meses diferentes. */
  const antiga = new Date("2026-06-15T12:00:00Z");
  const nova = new Date("2026-08-20T12:00:00Z");
  const vAntiga = await criarVenda(antiga, [{ sku: "KIT-1", preco: 10000, qtd: 1 }]);
  const vNova = await criarVenda(nova, [{ sku: "KIT-1", preco: 10000, qtd: 2 }]);

  console.log("\n== sem custo cadastrado ==");
  eq("não inventa zero", await aplicarCustos(t.id, vAntiga, antiga), null);
  const [o1] = await sql`SELECT cogs_cents FROM orders WHERE id = ${vAntiga}`;
  eq("cogs fica nulo, não zero", o1.cogs_cents, null);

  console.log("\n== custo cadastrado retroage ==");
  await sql`INSERT INTO product_costs (tenant_id, sku, unit_cost_cents, effective_from)
    VALUES (${t.id}, 'KIT-1', 4000, '2000-01-01')`;
  eq("aplica na venda antiga", await aplicarCustos(t.id, vAntiga, antiga), 4000);
  eq("multiplica pela quantidade", await aplicarCustos(t.id, vNova, nova), 8000);

  console.log("\n== reajuste do fornecedor não reescreve o passado ==");
  await sql`INSERT INTO product_costs (tenant_id, sku, unit_cost_cents, effective_from)
    VALUES (${t.id}, 'KIT-1', 6000, '2026-08-01')`;

  eq("venda de junho mantém o custo antigo", await aplicarCustos(t.id, vAntiga, antiga), 4000);
  eq("venda de agosto usa o custo novo", await aplicarCustos(t.id, vNova, nova), 12000);

  console.log("\n== recalcular passa em tudo ==");
  const n = await recalcular(t.id, "KIT-1");
  eq("mexeu nas duas vendas", n, 2);
  const [a] = await sql`SELECT cogs_cents FROM orders WHERE id = ${vAntiga}`;
  const [b] = await sql`SELECT cogs_cents FROM orders WHERE id = ${vNova}`;
  eq("junho continua com 40,00", Number(a.cogs_cents), 4000);
  eq("agosto com 120,00", Number(b.cogs_cents), 12000);

  console.log("\n== a lista mostra o que falta ==");
  await criarVenda(nova, [{ sku: "SEM-CUSTO", preco: 25000, qtd: 1 }]);
  const lista = await skusComCusto(t.id);
  const kit = lista.find((s) => s.sku === "KIT-1");
  const sem = lista.find((s) => s.sku === "SEM-CUSTO");

  eq("dois SKUs", lista.length, 2);
  /* KIT-1 somou 30.000 (10.000 + 2 x 10.000) contra 25.000 do outro. */
  eq("ordenado por faturamento, maior primeiro", lista[0].sku, "KIT-1");
  eq("faturamento do KIT-1", kit.faturamentoCents, 30000);
  eq("custo vigente é o mais recente", kit.custoCents, 6000);
  eq("conta as versões", kit.versoes, 2);
  eq("SKU sem custo aparece com null", sem.custoCents, null);
  eq("e com o faturamento dele", sem.faturamentoCents, 25000);
  eq("KIT-1 somou as duas vendas", kit.vendas, 2);

  console.log("\n== custo futuro não vale hoje ==");
  await sql`INSERT INTO product_costs (tenant_id, sku, unit_cost_cents, effective_from)
    VALUES (${t.id}, 'KIT-1', 9900, now() + interval '30 days')`;
  const depois = await skusComCusto(t.id);
  eq("vigente continua sendo o de agosto", depois.find((s) => s.sku === "KIT-1").custoCents, 6000);

  await sql`DELETE FROM tenants WHERE slug = 'custo-teste'`;
  console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
  process.exit(f === 0 ? 0 : 1);
})();
