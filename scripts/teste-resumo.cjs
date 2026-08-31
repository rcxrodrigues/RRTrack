/*
 * As consultas do Resumo e da saúde do rastreamento, contra o banco real.
 *
 * O que precisa ficar provado são as decisões que mudam o número na tela:
 * visitante contado uma vez mesmo recarregando a página, líquido descontando
 * taxa e reembolso, e método de atribuição aparecendo zerado em vez de sumir.
 *
 * Compilar antes:
 *   npx tsc src/core/resumo.ts src/core/rastreio.ts --outDir _tmp \
 *     --target ES2022 --module commonjs --moduleResolution node \
 *     --skipLibCheck --esModuleInterop
 *   echo {"type":"commonjs"} > _tmp/package.json
 *   node scripts/teste-resumo.cjs
 */
const { neon } = require("@neondatabase/serverless");
const { webcrypto: wc } = require("node:crypto");
process.loadEnvFile(".env");
const sql = neon(process.env.DATABASE_URL);
const R = require("../_tmp/core/resumo.js");
const T = require("../_tmp/core/rastreio.js");

let f = 0;
const eq = (l, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  if (!ok) f++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${l}` + (ok ? "" : `  obtido ${JSON.stringify(g)}, esperado ${JSON.stringify(w)}`));
};

(async () => {
  await sql`DELETE FROM tenants WHERE slug = 'resumo-teste'`;
  const [t] = await sql`INSERT INTO tenants (name, slug, timezone) VALUES ('R', 'resumo-teste', 'America/Sao_Paulo') RETURNING id`;
  const [site] = await sql`INSERT INTO sites (tenant_id, domain, public_key) VALUES (${t.id}, ${"r" + Date.now() + ".ex"}, ${"pk_r" + Date.now()}) RETURNING id`;
  const [conn] = await sql`INSERT INTO gateway_connections (tenant_id, gateway, label, webhook_secret) VALUES (${t.id}, 'pagou', 'P', ${"ws" + Date.now()}) RETURNING id`;
  const [dest] = await sql`INSERT INTO destinations (tenant_id, platform, label, external_id, credentials) VALUES (${t.id}, 'meta', 'Pixel', '1', '{}'::jsonb) RETURNING id`;

  /*
   * O dia precisa ser o do FUSO DA LOJA, não o de UTC.
   *
   * A query converte occurred_at para America/Sao_Paulo antes de comparar. Entre
   * 00h e 03h UTC — 21h e 00h em São Paulo — o dia UTC já virou e o de São Paulo
   * não, então "hoje" em UTC não contém venda nenhuma gravada agora. Esta suíte
   * passava 21 horas por dia e falhava nas outras 3.
   */
  const hoje = new Date()
    .toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" })
    .slice(0, 10);
  const DIRETO = "(direto)";

  const ses = [];
  for (const [src, med, camp] of [["facebook", "cpc", "Frio"], ["facebook", "cpc", "Frio"], ["google", "organic", null], ["", "", null]]) {
    const id = wc.randomUUID();
    ses.push(id);
    await sql`INSERT INTO click_sessions (click_id, tenant_id, site_id, utm_source, utm_medium, campaign_name, campaign_id)
      VALUES (${id}, ${t.id}, ${site.id}, ${src || null}, ${med || null}, ${camp}, ${camp ? "C1" : null})`;
  }

  for (const [i, nome] of [[0, "page_view"], [1, "page_view"], [2, "page_view"], [3, "page_view"],
                           [0, "view_item"], [1, "view_item"], [2, "view_item"],
                           [0, "add_to_cart"], [1, "add_to_cart"],
                           [0, "begin_checkout"]]) {
    await sql`INSERT INTO events (tenant_id, click_id, name, event_id, occurred_at)
      VALUES (${t.id}, ${ses[i]}, ${nome}, ${"e" + wc.randomUUID()}, now())`;
  }
  /* Recarregou a página: mesmo clickId, outro evento. Não pode virar visitante novo. */
  await sql`INSERT INTO events (tenant_id, click_id, name, event_id, occurred_at)
    VALUES (${t.id}, ${ses[0]}, 'page_view', ${"e" + wc.randomUUID()}, now())`;

  const ids = [];
  for (const [s, st, v, taxa, custo, met, atr] of [
    [ses[0], "paid", 20000, 500, 6000, "pix", "click_id"],
    [ses[1], "paid", 15000, 400, null, "credit_card", "fbp_match"],
    [ses[2], "pending", 30000, null, null, "boleto", "unattributed"],
    [ses[0], "refunded", 10000, null, null, "pix", "click_id"],
  ]) {
    const [o] = await sql`INSERT INTO orders (tenant_id, gateway_connection_id, gateway_order_id, status, gross_cents, fee_cents, cogs_cents, payment_method, click_id, attribution_method, occurred_at)
      VALUES (${t.id}, ${conn.id}, ${"o" + wc.randomUUID()}, ${st}, ${v}, ${taxa}, ${custo}, ${met}, ${s}, ${atr}, now()) RETURNING id`;
    ids.push(o.id);
  }

  for (const [oid, est, chaves] of [
    [ids[0], "sent", ["em", "ph", "fbp", "fbc", "ip"]],
    [ids[1], "sent", ["em", "fbp", "ip"]],
    [ids[1], "failed", null],
  ]) {
    await sql`INSERT INTO dispatches (tenant_id, destination_id, order_id, event_name, event_id, status, match_key_count, match_keys)
      VALUES (${t.id}, ${dest.id}, ${oid}, 'purchase', ${"d" + wc.randomUUID()}, ${est}, ${chaves ? chaves.length : null}, ${chaves ? JSON.stringify(chaves) : null}::jsonb)`;
  }

  const p = { tenantId: t.id, de: hoje, ate: hoje, timezone: "America/Sao_Paulo", moeda: "BRL" };

  console.log("\n== indicadores ==");
  const ind = await R.indicadores(p);
  eq("faturamento bruto conta só as pagas", ind.faturamentoBrutoCents, 35000);
  eq("taxas somadas", ind.taxasCents, 900);
  eq("reembolso contado à parte", ind.reembolsosCents, 10000);
  eq("líquido = bruto − taxas − reembolso", ind.faturamentoLiquidoCents, 24100);
  eq("custo do produto só onde existe", ind.custoProdutoCents, 6000);
  eq("vendas aprovadas", ind.vendasAprovadas, 2);
  eq("pendentes contadas à parte", ind.vendasPendentes, 1);
  eq("valor pendente", ind.pendenteCents, 30000);
  eq("ticket médio sobre o bruto", ind.ticketMedioCents, 17500);
  eq("ROAS é null sem gasto, não zero", ind.roas, null);
  eq("lucro = líquido − custo − gasto", ind.lucroCents, 18100);
  /* Em pontos percentuais: 18100/24100 = 75,1%. Sem esta asserção a margem
     saiu como proporção por muito tempo, e a tela mostrava 0,8% no lugar. */
  eq("margem em pontos percentuais", Math.round(ind.margem * 10) / 10, 75.1);

  console.log("\n== funil ==");
  const fun = await R.funil(p);
  eq("cinco etapas", fun.length, 5);
  eq("conta VISITANTES, não eventos", fun[0].valor, 4);
  eq("viu produto", fun[1].valor, 3);
  eq("carrinho", fun[2].valor, 2);
  eq("checkout", fun[3].valor, 1);
  eq("comprou", fun[4].valor, 2);
  eq("topo não tem taxa", fun[0].taxa, null);
  eq("passagem visita para produto", fun[1].taxa, 75);
  eq("etapa normal não tem excedente", fun[1].excedente, 0);

  /*
   * A semente tem 1 no checkout e 2 compras — de propósito, porque é o que
   * acontece de verdade: alguém comprou sem o navegador ter visto, ou o script
   * não carregou na visita dele.
   *
   * A conta ingênua daria 200% de conversão. Número impossível na tela faz a
   * pessoa desconfiar do painel inteiro, inclusive das partes certas — então
   * não há taxa, e o excedente diz o que houve.
   */
  eq("mais compras que checkouts não vira 200%", fun[4].taxa, null);
  eq("e o excedente diz quantos foram", fun[4].excedente, 1);

  console.log("\n== horário ==");
  const hs = await R.porHorario(p);
  eq("soma as vendas pagas", hs.reduce((s, c) => s + c.vendas, 0), 2);
  eq("dia da semana entre 0 e 6", hs.every((c) => c.dia >= 0 && c.dia <= 6), true);

  console.log("\n== origem ==");
  const or = await R.porOrigem(p);
  const fb = or.find((o) => o.fonte.startsWith("facebook"));
  eq("facebook aparece", !!fb, true);
  eq("sessão sem utm vira direto", or.some((o) => o.fonte.startsWith(DIRETO)), true);
  eq("faturamento do facebook", fb.faturamentoCents, 35000);
  eq("duas sessões", fb.sessoes, 2);

  console.log("\n== pagamento ==");
  const pg = await R.porPagamento(p);
  const pix = pg.find((x) => x.metodo === "Pix");
  eq("pix: 1 aprovada de 2", pix.aprovadas, 1);
  eq("taxa de aprovação", pix.taxa, 50);

  console.log("\n== atribuição ==");
  const at = await T.porAtribuicao(p);
  eq("cinco métodos sempre", at.length, 5);
  eq("ordem fixa por confiança", at[0].metodo, "click_id");
  eq("click_id com 1 venda", at.find((a) => a.metodo === "click_id").vendas, 1);
  eq("fbp_match com 1 venda", at.find((a) => a.metodo === "fbp_match").vendas, 1);
  eq("método sem venda aparece zerado", at.find((a) => a.metodo === "order_claim").vendas, 0);
  eq("click_id é certeza", at.find((a) => a.metodo === "click_id").porChave, true);
  eq("fbp_match é palpite", at.find((a) => a.metodo === "fbp_match").porChave, false);

  console.log("\n== disparos ==");
  const rd = await T.resumoDisparos(p);
  eq("entregues", rd.entregues, 2);
  eq("falharam", rd.falharam, 1);
  eq("média só dos entregues", rd.mediaChaves, 4);

  const ult = await T.ultimosDisparos(p);
  eq("lista os três", ult.length, 3);
  eq("traz as chaves", ult.some((d) => d.chaves.length === 5), true);
  eq("traz o gateway", ult.every((d) => d.gateway === "pagou"), true);

  console.log("\n== UTMs ==");
  const u1 = await T.porUtm(p, "fonte");
  const ufb = u1.find((l) => l.fonte === "facebook");
  eq("agrupa por fonte", !!ufb, true);
  eq("conversão do facebook", ufb.taxaConversao, 100);
  const u2 = await T.porUtm(p, "campanha");
  eq("agrupa por campanha", u2.some((l) => l.campanha === "Frio"), true);

  /*
   * A BORDA DO DIA, que ja quebrou este painel uma vez.
   *
   * Sao Paulo e UTC-3. Uma venda as 23:30 UTC aconteceu as 20:30 de Sao Paulo,
   * no mesmo dia; uma as 02:30 UTC do dia seguinte aconteceu as 23:30 de Sao
   * Paulo, AINDA no dia anterior.
   *
   * Ler qualquer uma das duas em UTC nao da erro: da hora errada no mapa de
   * horario e, na segunda, dia errado no faturamento. Foi assim que tres horas
   * por dia sumiram do painel antes — e o numero continuava plausivel.
   */
  console.log("\n== a borda do dia ==");

  const DIA_SP = "2026-08-20";
  for (const quando of ["2026-08-20T23:30:00Z", "2026-08-21T02:30:00Z"]) {
    await sql`INSERT INTO orders (tenant_id, gateway_connection_id, gateway_order_id, status, gross_cents, payment_method, click_id, attribution_method, occurred_at)
      VALUES (${t.id}, ${conn.id}, ${"b" + wc.randomUUID()}, 'paid', 10000, 'pix', ${ses[0]}, 'click_id', ${quando})`;
  }

  const pBorda = { ...p, de: DIA_SP, ate: DIA_SP };
  const hb = await R.porHorario(pBorda);

  eq("as duas caem no mesmo dia de Sao Paulo", hb.reduce((s, c) => s + c.vendas, 0), 2);
  eq("23:30 UTC vira 20h em Sao Paulo", hb.some((c) => c.hora === 20), true);
  eq("02:30 UTC do dia seguinte vira 23h do dia anterior",
    hb.some((c) => c.hora === 23), true);
  eq("e nenhuma aparece na hora de UTC",
    hb.some((c) => c.hora === 2 || c.hora === 23.5), false);

  /* E o faturamento do dia tem que ver as duas, senao some R$ 200 do dia. */
  const iBorda = await R.indicadores(pBorda);
  eq("as duas entram no faturamento do dia", iBorda.faturamentoBrutoCents, 20000);

  /*
   * A VIRADA, no segundo.
   *
   * 23:59:59 do dia 20 ainda e dia 20; 00:00:00 do dia 21 ja e dia 21. Parece
   * obvio, e e justamente o que quebra quando o filtro compara INSTANTE em vez
   * de DATA: com `occurred_at BETWEEN de AND ate`, o `ate` vale meia-noite e
   * o dia inteiro depois disso some — o dia corrente aparece sempre vazio.
   *
   * Sao Paulo e UTC-3, entao a virada local acontece as 03:00 UTC.
   */
  const [a20] = await sql`INSERT INTO orders (tenant_id, gateway_connection_id, gateway_order_id, status, gross_cents, payment_method, click_id, attribution_method, occurred_at)
    VALUES (${t.id}, ${conn.id}, ${"v" + wc.randomUUID()}, 'paid', 700, 'pix', ${ses[0]}, 'click_id', '2026-08-21T02:59:59Z') RETURNING id`;
  const [a21] = await sql`INSERT INTO orders (tenant_id, gateway_connection_id, gateway_order_id, status, gross_cents, payment_method, click_id, attribution_method, occurred_at)
    VALUES (${t.id}, ${conn.id}, ${"v" + wc.randomUUID()}, 'paid', 900, 'pix', ${ses[0]}, 'click_id', '2026-08-21T03:00:00Z') RETURNING id`;

  const dia20 = await R.indicadores({ ...p, de: "2026-08-20", ate: "2026-08-20" });
  const dia21 = await R.indicadores({ ...p, de: "2026-08-21", ate: "2026-08-21" });

  /* O dia 20 ja tinha R$ 200 do bloco acima; a venda das 23:59:59 soma R$ 7. */
  eq("23:59:59 ainda conta no dia 20", dia20.faturamentoBrutoCents, 20700);
  eq("00:00:00 ja conta no dia 21", dia21.faturamentoBrutoCents, 900);
  eq("e nenhuma aparece nos dois", dia20.faturamentoBrutoCents + dia21.faturamentoBrutoCents, 21600);

  /* Limpa para nao contaminar o que roda depois. */
  await sql`DELETE FROM orders WHERE id IN (${a20.id}, ${a21.id})`;

  await sql`DELETE FROM tenants WHERE slug = 'resumo-teste'`;


  console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
  process.exit(f === 0 ? 0 : 1);
})();
