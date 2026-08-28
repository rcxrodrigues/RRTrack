/*
 * Valida o disparo de PURCHASE contra o pixel REAL, sem venda de verdade.
 *
 * Os eventos de navegação se provam sozinhos: qualquer visita gera
 * `view_content` e o painel mostra o resultado. O `purchase` não — ele só
 * nasce quando o gateway avisa que alguém pagou, e é justamente o evento que
 * carrega e-mail, telefone e nome, os campos que decidem a qualidade da
 * correspondência. Descobrir na primeira venda real que a Meta recusa o
 * payload é caro: essa venda não volta.
 *
 * Este script encena a venda inteira contra a produção usando o
 * `test_event_code` da Meta, que manda o evento para a aba "Eventos de teste":
 * chega, é conferível, e não entra na atribuição nem no histórico do pixel.
 * No fim, tudo que ele criou no banco é apagado.
 *
 *   node scripts/testar-purchase-real.mjs "PX1 | BM1=TEST123" "PX1 | BM3=TEST456"
 *
 * O código sai do Gerenciador de Eventos -> seu pixel -> Eventos de teste ->
 * "Confirme se os eventos do seu SERVIDOR estão configurados corretamente".
 *
 * É um código por pixel, e todos os destinos ativos precisam do seu. O disparo
 * vai para todos de uma vez: o que ficar sem código — ou com o código de outro
 * pixel — recebe a venda encenada como venda DE VERDADE, e isso não dá para
 * desfazer no lado da Meta. Por isso o script se recusa a começar enquanto
 * faltar um.
 *
 * Com --pausar-restantes ele desativa quem ficou sem código pelo tempo do
 * teste e reativa no fim. Serve para testar um pixel de cada vez sem ter de
 * juntar todos os códigos antes. Enquanto durar, esse destino não recebe nada
 * — inclusive de visitante real, se houver um passando na hora.
 */
import { neon } from "@neondatabase/serverless";
import { webcrypto as wc } from "node:crypto";

process.loadEnvFile(".env");
const sql = neon(process.env.DATABASE_URL);

const DOMINIO = process.env.RR_DOMINIO || "florecomesticos.store";
const BASE = process.env.RR_BASE || "https://t.florecomesticos.store";

const args = process.argv.slice(2);
const PAUSAR = args.includes("--pausar-restantes");

/* "Rótulo do destino=CÓDIGO", um argumento por pixel. */
const CODIGOS = new Map(
  args.filter((a) => !a.startsWith("--")).map((a) => {
    const i = a.indexOf("=");
    if (i < 0) {
      console.error(`Argumento "${a}" não tem o formato "Rótulo do destino=TEST12345".`);
      process.exit(1);
    }
    return [a.slice(0, i).trim(), a.slice(i + 1).trim()];
  }),
);

if (CODIGOS.size === 0) {
  console.error('Uso: node scripts/testar-purchase-real.mjs "PX1 | BM1=TEST123" "PX1 | BM3=TEST456"');
  process.exit(1);
}

const CLICK_ID = wc.randomUUID();
const TRX = "teste_rr_" + Buffer.from(wc.getRandomValues(new Uint8Array(6))).toString("hex");

let falhas = 0;
const ok = (label, cond, extra = "") => {
  if (!cond) falhas++;
  console.log(`  ${cond ? "ok   " : "FALHA"} | ${label}${extra ? "  -> " + extra : ""}`);
};

/* -------------------------------------------------- quem vamos testar --- */

const [site] = await sql`SELECT * FROM sites WHERE domain = ${DOMINIO}`;
if (!site) { console.error(`Site "${DOMINIO}" não encontrado.`); process.exit(1); }

/*
 * A loja pode ter mais de um gateway conectado, e o payload encenado abaixo
 * tem o formato de um deles só. Pegar "o primeiro" manda o corpo errado para
 * o adaptador errado: ele responde 200, ignora, e o teste falha por um motivo
 * que não é o que se queria medir.
 */
const GATEWAY = (args.find((a) => a.startsWith("--gateway=")) || "--gateway=pagou").split("=")[1];

const [gw] = await sql`
  SELECT * FROM gateway_connections
  WHERE tenant_id = ${site.tenant_id} AND gateway = ${GATEWAY} LIMIT 1`;

if (!gw) {
  const todos = await sql`
    SELECT gateway FROM gateway_connections WHERE tenant_id = ${site.tenant_id}`;
  console.error(`Nenhuma conexão "${GATEWAY}" neste site.`);
  console.error(`Conectados: ${todos.map((g) => g.gateway).join(", ")}`);
  process.exit(1);
}

const destinos = await sql`
  SELECT id, label, test_event_code FROM destinations
  WHERE tenant_id = ${site.tenant_id} AND active AND platform = 'meta'`;
if (destinos.length === 0) { console.error("Nenhum destino Meta ativo."); process.exit(1); }

/* Nenhum destino ativo pode ficar de fora — ver o comentário do cabeçalho. */
const semCodigo = destinos.filter((d) => !CODIGOS.get(d.label));
if (semCodigo.length > 0 && !PAUSAR) {
  console.error("\nEstes destinos estão ativos e ficaram sem código de teste:\n");
  for (const d of semCodigo) console.error(`  "${d.label}=TEST…"`);
  console.error("\nSem o código deles, a venda encenada entraria como venda real.");
  console.error("Passe o código de cada um, ou use --pausar-restantes para deixá-los de fora.");
  process.exit(1);
}

/* Só quem tem código é testado; o resto sai do ar por alguns segundos. */
const alvos = destinos.filter((d) => CODIGOS.get(d.label));

const sobrando = [...CODIGOS.keys()].filter((l) => !destinos.some((d) => d.label === l));
if (sobrando.length > 0) {
  console.error(`\nNão existe destino Meta ativo com o rótulo: ${sobrando.join(", ")}`);
  console.error(`Ativos: ${destinos.map((d) => d.label).join(", ")}`);
  process.exit(1);
}

console.log(`\nLoja:     ${DOMINIO}`);
console.log(`Gateway:  ${gw.gateway} · ${gw.label}`);
console.log(`Testando: ${alvos.map((d) => d.label).join(", ")}`);
if (semCodigo.length > 0) console.log(`Pausados: ${semCodigo.map((d) => d.label).join(", ")}`);
console.log(`Pedido:   ${TRX}  (encenado — será apagado no fim)\n`);

/* Guarda o que estava lá para devolver depois, aconteça o que acontecer. */
const anteriores = new Map(destinos.map((d) => [d.id, d.test_event_code]));

async function restaurar() {
  for (const [id, valor] of anteriores) {
    await sql`UPDATE destinations SET test_event_code = ${valor} WHERE id = ${id}`;
  }
  for (const d of semCodigo) {
    await sql`UPDATE destinations SET active = true WHERE id = ${d.id}`;
  }
}

async function limpar() {
  const [venda] = await sql`SELECT id FROM orders WHERE gateway_order_id = ${TRX}`;
  if (venda) {
    await sql`DELETE FROM dispatches WHERE order_id = ${venda.id}`;
    await sql`DELETE FROM order_items WHERE order_id = ${venda.id}`;
    await sql`DELETE FROM orders WHERE id = ${venda.id}`;
  }
  /*
   * O page_view do passo 2 também vira disparo, e ele não tem order_id — some
   * do `events` e a linha em `dispatches` fica órfã, inflando a contagem de
   * page_view do dia com tráfego que nunca existiu.
   */
  await sql`DELETE FROM dispatches WHERE event_id = ${"pv." + CLICK_ID}`;
  await sql`DELETE FROM events WHERE click_id = ${CLICK_ID}`;
  await sql`DELETE FROM click_sessions WHERE click_id = ${CLICK_ID}`;
}

process.on("uncaughtException", async (e) => {
  console.error("\n" + e.message);
  await restaurar();
  await limpar();
  process.exit(1);
});

/* ------------------------------------------------------ 1. modo teste --- */

console.log("1. destinos em modo teste");
for (const d of semCodigo) {
  await sql`UPDATE destinations SET active = false WHERE id = ${d.id}`;
  console.log(`   ${d.label} → pausado (volta no fim)`);
}
for (const d of alvos) {
  const codigo = CODIGOS.get(d.label);
  await sql`UPDATE destinations SET test_event_code = ${codigo} WHERE id = ${d.id}`;
  console.log(`   ${d.label} → ${codigo}`);
}

/* -------------------------------------------------------- 2. o clique --- */

console.log("\n2. o clique que originou a venda");

const r1 = await fetch(`${BASE}/rr/collect`, {
  method: "POST",
  headers: {
    "content-type": "text/plain",
    "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
  },
  body: JSON.stringify({
    site_key: site.public_key,
    click_id: CLICK_ID,
    external_id: wc.randomUUID(),
    event: "page_view",
    event_id: "pv." + CLICK_ID,
    attribution: {
      utm_source: "facebook",
      utm_medium: "cpc",
      utm_campaign: "teste-purchase-real",
      fbclid: "IwAR" + CLICK_ID.slice(0, 12),
      landing_url: `https://www.${DOMINIO}/`,
    },
    fbp: "fb.1." + Date.now() + ".1234567890",
    fbc: "fb.1." + Date.now() + ".IwAR" + CLICK_ID.slice(0, 12),
    page_url: `https://www.${DOMINIO}/`,
    occurred_at: new Date().toISOString(),
  }),
});
ok("coletor aceitou o beacon", r1.status === 204, `status ${r1.status}`);

const [sessao] = await sql`SELECT * FROM click_sessions WHERE click_id = ${CLICK_ID}`;
ok("sessão de clique gravada", !!sessao);
ok("fbc guardado", !!sessao?.fbc);

/* --------------------------------------------------------- 3. a venda --- */

console.log("\n3. o gateway avisa que foi pago");

const r2 = await fetch(`${BASE}/api/webhook/${gw.gateway}/${gw.webhook_secret}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    id: "evt_" + TRX,
    event: "transaction.paid",
    api_version: "v2",
    data: {
      id: TRX,
      status: "paid",
      amount: 2990,
      currency: "BRL",
      payment_method: "pix",
      paid_at: new Date().toISOString(),
      customer: {
        name: "Teste RRTrack",
        email: "teste.rrtrack@example.com",
        phone: "(11) 90000-0000",
      },
      products: [
        { external_id: "1313", name: "Carimbo de Delineador", quantity: 1, unit_price: 2990 },
      ],
      attribution: { utm_source: "facebook", utm_campaign: "teste-purchase-real", sck: CLICK_ID },
    },
  }),
});
ok("webhook aceito", r2.status === 200, `status ${r2.status}`);

const [venda] = await sql`SELECT * FROM orders WHERE gateway_order_id = ${TRX}`;
ok("venda gravada", !!venda);
ok("ligada ao clique", venda?.click_id === CLICK_ID);

/* ---------------------------------------------------------- 4. a Meta --- */

console.log("\n4. o que a Meta respondeu");

/* O disparo é assíncrono; espera até uns 20s antes de desistir. */
let disparos = [];
for (let i = 0; i < 20 && disparos.length < alvos.length; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  disparos = await sql`
    SELECT d.label, di.status, di.match_keys, di.response_body, di.error
    FROM dispatches di JOIN destinations d ON d.id = di.destination_id
    WHERE di.order_id = ${venda?.id}`;
}

ok("um disparo por destino testado", disparos.length === alvos.length, `${disparos.length}/${alvos.length}`);
ok("nada foi para os pausados", !disparos.some((d) => semCodigo.some((p) => p.label === d.label)));

for (const d of disparos) {
  const chaves = d.match_keys ?? [];
  console.log(`\n  ${d.label}`);
  ok("  aceito pela Meta", d.status === "sent", d.error ?? "");
  console.log(`     chaves (${chaves.length}): ${chaves.join(", ")}`);
  for (const k of ["em", "ph", "fn", "ln", "fbp", "fbc", "external_id", "ip", "user_agent"]) {
    if (!chaves.includes(k)) ok(`     chave ${k} presente`, false);
  }
  if (d.status !== "sent") console.log("     resposta: " + JSON.stringify(d.response_body));
}

/* ---------------------------------------------------------- 5. faxina --- */

console.log("\n5. desfazendo o que este teste criou");
await restaurar();
await limpar();
const [sobrou] = await sql`SELECT id FROM orders WHERE gateway_order_id = ${TRX}`;
ok("pedido encenado removido", !sobrou);

const ativos = await sql`
  SELECT count(*)::int AS n FROM destinations
  WHERE tenant_id = ${site.tenant_id} AND platform = 'meta' AND active`;
ok("todos os destinos de volta ao ar", ativos[0].n === destinos.length, `${ativos[0].n}/${destinos.length}`);

const restantes = await sql`
  SELECT count(*)::int AS n FROM destinations
  WHERE tenant_id = ${site.tenant_id} AND test_event_code IS NOT NULL AND active`;
ok("nenhum destino ficou em modo teste", restantes[0].n === 0, `${restantes[0].n}`);

console.log("\n" + (falhas === 0
  ? "PASSOU — confira o evento na aba Eventos de teste do Gerenciador."
  : falhas + " FALHA(S)") + "\n");
process.exit(falhas === 0 ? 0 : 1);
