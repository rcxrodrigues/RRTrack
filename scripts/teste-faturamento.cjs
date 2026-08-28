/*
 * O que conta como faturamento, e o placar acumulado.
 *
 * Testa a coisa que muda dinheiro sem parecer que mudou: desligar "contabilizar
 * frete" tira receita de todo lugar ao mesmo tempo — resumo, tela de plataforma
 * e placar. Se um dos três discordar, o painel passa a se contradizer sozinho,
 * e ninguém confia mais em nenhum dos números.
 */
const { neon } = require("@neondatabase/serverless");
const { webcrypto: wc } = require("node:crypto");
process.loadEnvFile(".env");
const sql = neon(process.env.DATABASE_URL);

const { metricas } = require("../_tmp/core/metricas.js");
const { indicadores } = require("../_tmp/core/resumo.js");
const { faturamentoAcumulado, placarDaLoja, faixaDe, FAIXAS, REGRA_PLACAR } = require("../_tmp/core/faixas.js");
const { valorEmMemoria, descreverRegra } = require("../_tmp/core/faturamento.js");

let f = 0;
const eq = (l, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) f++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${l}` + (ok ? "" : `  obtido ${JSON.stringify(g)}, esperado ${JSON.stringify(w)}`)); };

(async () => {
await sql`DELETE FROM tenants WHERE slug = 'faturamento-teste'`;
const [t] = await sql`INSERT INTO tenants (name, slug, timezone) VALUES ('Faturamento', 'faturamento-teste', 'America/Sao_Paulo') RETURNING id`;
const [site] = await sql`INSERT INTO sites (tenant_id, domain, public_key) VALUES (${t.id}, ${'f'+Date.now()+'.exemplo'}, ${'pk_f_'+Date.now()}) RETURNING id`;
const [conta] = await sql`INSERT INTO ad_accounts (tenant_id, platform, external_id, label, credentials) VALUES (${t.id}, 'meta', 'act_f', 'Conta', '{}'::jsonb) RETURNING id`;
const [conn] = await sql`INSERT INTO gateway_connections (tenant_id, gateway, label, webhook_secret) VALUES (${t.id}, 'appmax', 'A', ${'ws_'+Date.now()}) RETURNING id`;

/* Dia no fuso da loja — a query converte antes de comparar. */
const hoje = new Date().toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).slice(0, 10);

await sql`INSERT INTO ad_spend_daily (tenant_id, ad_account_id, platform, date, campaign_id, campaign_name, ad_id, ad_name, spend_cents, impressions, clicks)
  VALUES (${t.id}, ${conta.id}, 'meta', ${hoje}, 'C1', 'Campanha', 'A1', 'Anuncio', 20000, 5000, 100)`;

const ses = wc.randomUUID();
await sql`INSERT INTO click_sessions (click_id, tenant_id, site_id, campaign_id, ad_id, utm_source)
  VALUES (${ses}, ${t.id}, ${site.id}, 'C1', 'A1', 'facebook')`;

/*
 * Duas vendas: produto 10.000 + frete 2.000 + juro 500 = 12.500 cada.
 * Total bruto 25.000, frete 4.000, juro 1.000.
 */
for (let i = 0; i < 2; i++) {
  await sql`INSERT INTO orders (tenant_id, gateway_connection_id, gateway_order_id, status, gross_cents, shipping_cents, interest_cents, click_id, attribution_method, occurred_at, paid_at)
    VALUES (${t.id}, ${conn.id}, ${'o'+wc.randomUUID()}, 'paid', 12500, 2000, 500, ${ses}, 'click_id', now(), now())`;
}
/* Uma venda sem frete nem juro informados: as colunas ficam NULL. */
await sql`INSERT INTO orders (tenant_id, gateway_connection_id, gateway_order_id, status, gross_cents, click_id, attribution_method, occurred_at, paid_at)
  VALUES (${t.id}, ${conn.id}, ${'o'+wc.randomUUID()}, 'paid', 30000, ${ses}, 'click_id', now(), now())`;

const TUDO   = { countShipping: true,  countInterest: true  };
const SEMF   = { countShipping: false, countInterest: true  };
const SEMJ   = { countShipping: true,  countInterest: false };
const NENHUM = { countShipping: false, countInterest: false };

const janela = { tenantId: t.id, plataforma: "meta", de: hoje, ate: hoje,
  timezone: "America/Sao_Paulo", nivel: "anuncio" };
const per = { tenantId: t.id, de: hoje, ate: hoje, timezone: "America/Sao_Paulo" };

console.log("\n== tela de plataforma ==");
const a = await metricas({ ...janela, regra: TUDO });
eq("tudo incluso", a[0]?.faturamentoCents, 55000);
const b = await metricas({ ...janela, regra: SEMF });
eq("sem frete tira 4.000", b[0]?.faturamentoCents, 51000);
const c = await metricas({ ...janela, regra: SEMJ });
eq("sem juros tira 1.000", c[0]?.faturamentoCents, 54000);
const d = await metricas({ ...janela, regra: NENHUM });
eq("sem os dois tira 5.000", d[0]?.faturamentoCents, 50000);

/* O ROAS acompanha: é o motivo de isto não ser preferência de exibição. */
eq("ROAS muda junto", Number(d[0]?.roas.toFixed(2)), 2.5);
eq("ROAS com tudo é outro", Number(a[0]?.roas.toFixed(2)), 2.75);

/*
 * O corte do dia acontece no fuso da LOJA, nunca em UTC.
 *
 * Este bloco existe porque o teste acima passava de manha e falhava a noite, e
 * ninguem desconfia de um teste que passa. A janela era montada em UTC: as 21h
 * em Sao Paulo ja e o dia seguinte la, entao toda venda do dia caia fora e o
 * faturamento da tela de campanhas zerava — enquanto o gasto continuava
 * aparecendo, porque a data dele e literal e nao passa por conversao.
 *
 * Aqui a venda e gravada num instante escolhido a dedo, 22h30 de Brasilia, que
 * e 01h30 do dia seguinte em UTC. Assim o teste faz a pergunta certa
 * independentemente da hora em que alguem o rodar.
 */
console.log("\n== o dia vira no fuso da loja, nao em UTC ==");
{
  const ontem = new Date(Date.now() - 864e5)
    .toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).slice(0, 10);
  const aNoite = new Date(ontem + "T22:30:00-03:00");

  const ses = wc.randomUUID();
  await sql`INSERT INTO click_sessions (click_id, tenant_id, site_id, campaign_id, ad_id, utm_source)
    VALUES (${ses}, ${t.id}, ${site.id}, 'C1', 'A1', 'facebook')`;
  await sql`INSERT INTO orders (tenant_id, gateway_connection_id, gateway_order_id, status,
      gross_cents, click_id, attribution_method, occurred_at, paid_at)
    VALUES (${t.id}, ${conn.id}, ${"noite-" + wc.randomUUID()}, 'paid', 7700, ${ses},
      'click_id', ${aNoite}, ${aNoite})`;
  await sql`INSERT INTO ad_spend_daily (tenant_id, ad_account_id, platform, date,
      campaign_id, campaign_name, ad_id, ad_name, spend_cents)
    VALUES (${t.id}, ${conta.id}, 'meta', ${ontem}, 'C1', 'Campanha', 'A1', 'Anuncio', 1000)`;

  const noite = await metricas({ ...janela, de: ontem, ate: ontem, regra: TUDO });
  eq("venda das 22h30 conta no dia dela", noite[0]?.faturamentoCents, 7700);
  eq("e o gasto do mesmo dia aparece junto", noite[0]?.gastoCents, 1000);

  /* A venda de ontem sai daqui: o placar acumulado mais abaixo soma TUDO da
     loja, sem recorte de data, e ela desregularia um teste que nao e sobre
     fuso nenhum. */
  await sql`DELETE FROM orders WHERE tenant_id = ${t.id} AND click_id = ${ses}`;
  await sql`DELETE FROM click_sessions WHERE click_id = ${ses}`;
  await sql`DELETE FROM ad_spend_daily WHERE tenant_id = ${t.id} AND date = ${ontem}`;
}

console.log("\n== resumo ==");
eq("bruto com tudo", (await indicadores({ ...per, regra: TUDO })).faturamentoBrutoCents, 55000);
eq("bruto sem frete", (await indicadores({ ...per, regra: SEMF })).faturamentoBrutoCents, 51000);
eq("bruto sem os dois", (await indicadores({ ...per, regra: NENHUM })).faturamentoBrutoCents, 50000);

console.log("\n== placar acumulado ==");
eq("acumulado com tudo", await faturamentoAcumulado(t.id, TUDO), 55000);
eq("acumulado sem os dois", await faturamentoAcumulado(t.id, NENHUM), 50000);

/*
 * O placar NÃO segue a regra da loja: frete e juro são dinheiro de passagem,
 * do transportador e do gateway, e um troféu que sobe com dinheiro alheio não
 * vale como troféu. Aqui não se decide nada — se olha distância.
 */
eq("placar ignora a regra da loja", REGRA_PLACAR, { countShipping: false, countInterest: false });
eq("acumulado padrão já vem líquido", await faturamentoAcumulado(t.id), 50000);
eq("placar usa o líquido", (await placarDaLoja(t.id)).totalCents, 50000);

console.log("\n== os tres concordam ==");
const m = await metricas({ ...janela, regra: SEMF });
const r = await indicadores({ ...per, regra: SEMF });
const p = await faturamentoAcumulado(t.id, SEMF);
eq("plataforma = resumo = placar", [m[0]?.faturamentoCents, r.faturamentoBrutoCents, p], [51000, 51000, 51000]);

console.log("\n== venda sem frete informado ==");
/* A de 30.000 tem shipping_cents NULL. Em SQL, 30000 - NULL é NULL — sem
   coalesce ela zeraria e o total cairia para 21.000 em vez de 51.000. */
eq("NULL não zera a venda", b[0]?.faturamentoCents, 51000);

console.log("\n== a mesma regra em memória ==");
eq("desconta frete", valorEmMemoria({ grossCents: 12500, shippingCents: 2000, interestCents: 500 }, SEMF), 10500);
eq("desconta os dois", valorEmMemoria({ grossCents: 12500, shippingCents: 2000, interestCents: 500 }, NENHUM), 10000);
eq("nulos não quebram", valorEmMemoria({ grossCents: 30000 }, NENHUM), 30000);
eq("tudo incluso não mexe", valorEmMemoria({ grossCents: 12500, shippingCents: 2000 }, TUDO), 12500);

console.log("\n== legenda ==");
eq("diz o que inclui", descreverRegra(TUDO), "inclui frete e juros");
eq("diz o que tirou", descreverRegra(NENHUM), "sem frete nem juros");
eq("diz só um", descreverRegra(SEMF), "sem frete");

console.log("\n== a marca e o preenchimento ==");
const zero = faixaDe(0);
eq("primeira marca é 10 mil", zero.ateCents, 1_000_000);
eq("barra vazia", zero.progresso, 0);

/* 60 mil reais: a próxima marca é 100 mil (10.000.000 centavos). */
const meio = faixaDe(6_000_000);
eq("marca certa", meio.ateCents, 10_000_000);
/*
 * O preenchimento é contra a MARCA, não dentro da faixa. A tela escreve os
 * dois números — "R$ 60 mil / R$ 100 mil" — e a barra tem que ser a razão
 * entre eles. Medir dentro da faixa daria 20% de barra ao lado de um par de
 * números que qualquer um lê como 60% do caminho.
 */
eq("preenchimento é total sobre a marca", Number(meio.progresso.toFixed(2)), 0.6);

const teto = faixaDe(FAIXAS[FAIXAS.length - 1] + 1);
eq("passou da última: sem marca", teto.ateCents, null);
eq("barra cheia", teto.progresso, 1);

/* Exatamente na marca já aponta para a seguinte, não para a que acabou. */
const naMarca = faixaDe(1_000_000);
eq("na marca, aponta para a próxima", naMarca.ateCents, 5_000_000);
eq("e o preenchimento recomeça", Number(naMarca.progresso.toFixed(1)), 0.2);

console.log("\n== não vaza entre lojas ==");
await sql`DELETE FROM tenants WHERE slug = 'faturamento-outro'`;
const [o] = await sql`INSERT INTO tenants (name, slug) VALUES ('Outro', 'faturamento-outro') RETURNING id`;
eq("outra loja não vê nada", await faturamentoAcumulado(o.id, TUDO), 0);

await sql`DELETE FROM tenants WHERE slug IN ('faturamento-teste','faturamento-outro')`;
console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
process.exit(f === 0 ? 0 : 1);
})();
