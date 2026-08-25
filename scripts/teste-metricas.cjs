/*
 * O cruzamento entre gasto e venda, contra o banco de verdade.
 *
 * Testa o que dá número errado sem parecer errado: ROI calculado sobre lucro e
 * não faturamento, venda pendente entrando no total, ROAS do total virando
 * média dos ROAS, e campanha que gastou sem vender sumindo da tela.
 *
 * Compilar antes (o _tmp precisa de package.json marcando commonjs):
 *   npx tsc src/core/metricas.ts --outDir _tmp --target ES2022  *     --module commonjs --moduleResolution node --skipLibCheck --esModuleInterop
 *   echo {"type":"commonjs"} > _tmp/package.json
 *   node scripts/teste-metricas.cjs
 */
const { neon } = require("@neondatabase/serverless");
const { webcrypto: wc } = require("node:crypto");
process.loadEnvFile(".env");
const sql = neon(process.env.DATABASE_URL);
const { metricas, totalizar } = require("../_tmp/core/metricas.js");

let f = 0;
const eq = (l, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) f++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${l}` + (ok ? "" : `  obtido ${JSON.stringify(g)}, esperado ${JSON.stringify(w)}`)); };

(async () => {
await sql`DELETE FROM tenants WHERE slug = 'metricas-teste'`;
const [t] = await sql`INSERT INTO tenants (name, slug, timezone) VALUES ('Métricas', 'metricas-teste', 'America/Sao_Paulo') RETURNING id`;
const [site] = await sql`INSERT INTO sites (tenant_id, domain, public_key) VALUES (${t.id}, ${'m'+Date.now()+'.exemplo'}, ${'pk_m_'+Date.now()}) RETURNING id`;
const [conta] = await sql`INSERT INTO ad_accounts (tenant_id, platform, external_id, label, credentials) VALUES (${t.id}, 'meta', 'act_1', 'Conta', '{}'::jsonb) RETURNING id`;
const [conn] = await sql`INSERT INTO gateway_connections (tenant_id, gateway, label, webhook_secret) VALUES (${t.id}, 'pagou', 'P', ${'ws_'+Date.now()}) RETURNING id`;

const hoje = new Date().toISOString().slice(0, 10);

for (const [ad, gasto, imp, cli] of [["AD1", 30000, 10000, 200], ["AD2", 20000, 8000, 100]]) {
  await sql`INSERT INTO ad_spend_daily (tenant_id, ad_account_id, platform, date, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name, spend_cents, impressions, clicks)
    VALUES (${t.id}, ${conta.id}, 'meta', ${hoje}, 'CAMP1', 'Campanha Fria', 'SET1', 'Conjunto A', ${ad}, ${'Anuncio '+ad}, ${gasto}, ${imp}, ${cli})`;
}

const s1 = wc.randomUUID(), s2 = wc.randomUUID();
for (const [id, ad] of [[s1, "AD1"], [s2, "AD2"]]) {
  await sql`INSERT INTO click_sessions (click_id, tenant_id, site_id, campaign_id, campaign_name, adset_id, ad_id, utm_source)
    VALUES (${id}, ${t.id}, ${site.id}, 'CAMP1', 'Campanha Fria', 'SET1', ${ad}, 'FB')`;
}

for (const [ses, valor, custo] of [[s1, 20000, 6000], [s1, 15000, null], [s2, 10000, 3000]]) {
  await sql`INSERT INTO orders (tenant_id, gateway_connection_id, gateway_order_id, status, gross_cents, cogs_cents, click_id, attribution_method, occurred_at, paid_at)
    VALUES (${t.id}, ${conn.id}, ${'o'+wc.randomUUID()}, 'paid', ${valor}, ${custo}, ${ses}, 'click_id', now(), now())`;
}
await sql`INSERT INTO orders (tenant_id, gateway_connection_id, gateway_order_id, status, gross_cents, click_id, attribution_method, occurred_at)
  VALUES (${t.id}, ${conn.id}, ${'pend'+wc.randomUUID()}, 'pending', 99900, ${s1}, 'click_id', now())`;

for (const [ses, n] of [[s1, 4], [s2, 1]]) {
  for (let i = 0; i < n; i++) {
    await sql`INSERT INTO events (tenant_id, click_id, name, event_id, occurred_at)
      VALUES (${t.id}, ${ses}, 'begin_checkout', ${'ic'+wc.randomUUID()}, now())`;
  }
}

const janela = { tenantId: t.id, plataforma: "meta", de: hoje, ate: hoje };

console.log("\n== por anúncio ==");
const ads = await metricas({ ...janela, nivel: "anuncio" });
eq("dois anúncios", ads.length, 2);
eq("ordenado por maior gasto", ads[0].id, "AD1");
const ad1 = ads.find((l) => l.id === "AD1");
eq("gasto", ad1.gastoCents, 30000);
eq("duas vendas", ad1.vendas, 2);
eq("faturamento somado", ad1.faturamentoCents, 35000);
eq("venda pendente NÃO entra", ad1.faturamentoCents !== 134900, true);
eq("custo do produto só onde existe", ad1.custoProdutoCents, 6000);
eq("lucro = fat − gasto − custo", ad1.lucroCents, -1000);
eq("ROAS", ad1.roas.toFixed(4), (35000/30000).toFixed(4));
eq("ROI usa lucro, não faturamento", ad1.roi.toFixed(4), (-1000/30000).toFixed(4));
eq("CPA", ad1.cpaCents, 15000);
eq("IC do nosso rastreamento", ad1.ic, 4);
eq("CPI", ad1.cpiCents, 7500);
eq("CPC", ad1.cpcCents, 150);
eq("CTR", ad1.ctr.toFixed(4), (200/10000).toFixed(4));
eq("CPM", ad1.cpmCents, 3000);

console.log("\n== por campanha (agrega os dois anúncios) ==");
const camps = await metricas({ ...janela, nivel: "campanha" });
eq("uma campanha", camps.length, 1);
eq("gasto somado", camps[0].gastoCents, 50000);
eq("vendas somadas", camps[0].vendas, 3);
eq("faturamento somado", camps[0].faturamentoCents, 45000);
eq("IC somado", camps[0].ic, 5);
eq("nome da campanha", camps[0].nome, "Campanha Fria");

console.log("\n== total ==");
const tot = totalizar(ads);
eq("ROAS recalculado, não média", tot.roas.toFixed(4), (45000/50000).toFixed(4));
eq("média dos ROAS daria outro número", ((ads[0].roas + ads[1].roas)/2).toFixed(4) !== tot.roas.toFixed(4), true);

console.log("\n== gastou e não vendeu ==");
await sql`INSERT INTO ad_spend_daily (tenant_id, ad_account_id, platform, date, campaign_id, campaign_name, ad_id, ad_name, spend_cents, impressions, clicks)
  VALUES (${t.id}, ${conta.id}, 'meta', ${hoje}, 'CAMP2', 'Queimando dinheiro', 'AD9', 'A9', 80000, 5000, 50)`;
const comPrejuizo = await metricas({ ...janela, nivel: "campanha" });
const ruim = comPrejuizo.find((l) => l.id === "CAMP2");
eq("aparece mesmo sem venda", !!ruim, true);
eq("é a primeira (maior gasto)", comPrejuizo[0].id, "CAMP2");
eq("ROAS zero, não N/A", ruim.roas, 0);
eq("lucro negativo", ruim.lucroCents, -80000);
eq("CPA é N/A sem venda", ruim.cpaCents, null);
eq("margem é N/A sem faturamento", ruim.margem, null);


/*
 * Os dois níveis que ninguém cobria.
 *
 * "Conjuntos" e "Contas" existem como aba na tela desde sempre, mas o teste só
 * exercitava anúncio e campanha. Um nível que agrupa errado não quebra nada —
 * só mostra número errado, em silêncio, justamente na aba que se abre para
 * decidir o que escalar e o que matar.
 */
console.log("\n== por conjunto ==");
const conjuntos = await metricas({ ...janela, nivel: "conjunto" });
eq("um conjunto", conjuntos.length, 1);
eq("gasto somado dos dois anúncios", conjuntos[0] && conjuntos[0].gastoCents, 50000);
eq("vendas somadas", conjuntos[0] && conjuntos[0].vendas, 3);
eq("faturamento somado", conjuntos[0] && conjuntos[0].faturamentoCents, 45000);
eq("nome do conjunto", conjuntos[0] && conjuntos[0].nome, "Conjunto A");

console.log("\n== por conta ==");
const contas = await metricas({ ...janela, nivel: "conta" });
eq("uma conta", contas.length, 1);
/* 130000 = os dois anúncios do conjunto A mais a campanha que só gastou. */
  eq("gasto da conta soma tudo", contas[0] && contas[0].gastoCents, 130000);
eq("vendas chegam na conta", contas[0] && contas[0].vendas, 3);
eq("faturamento chega na conta", contas[0] && contas[0].faturamentoCents, 45000);
eq("IC chega na conta", contas[0] && contas[0].ic, 5);

console.log("\n== filtro por nome ==");
const filtrado = await metricas({ ...janela, nivel: "campanha", nome: "queimando" });
eq("acha sem diferenciar maiúscula", filtrado.length, 1);
eq("é a certa", filtrado[0].id, "CAMP2");

console.log("\n== não vaza entre lojas ==");
const [outra] = await sql`SELECT id FROM tenants WHERE slug != 'metricas-teste' LIMIT 1`;
const deOutra = await metricas({ tenantId: outra.id, plataforma: "meta", de: hoje, ate: hoje, nivel: "campanha" });
eq("outra loja não vê nada disto", deOutra.some((l) => l.id === "CAMP1"), false);

await sql`DELETE FROM tenants WHERE slug = 'metricas-teste'`;
console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
process.exit(f === 0 ? 0 : 1);
})();
