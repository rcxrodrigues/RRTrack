/*
 * Reconciliação: a venda que aconteceu e nunca chegou aqui.
 *
 * Dois modos de perder uma venda inteira, e este teste cobre os dois:
 * o webhook chegou e o processamento morreu (o corpo cru está guardado), e o
 * webhook nunca chegou (só a reivindicação da loja aponta que houve pedido).
 *
 * A asserção que mais importa é a de idempotência. Uma varredura que rodasse
 * duas vezes e disparasse duas conversões seria pior que não existir: a Meta
 * passaria a contar o dobro, o ROAS mentiria para cima, e a decisão de escalar
 * a campanha sairia de um número inventado.
 *
 * A segunda é o teto de consultas. Reivindicação órfã quase sempre é carrinho
 * abandonado, não venda perdida — sem teto, cada abandono viraria consulta por
 * hora para sempre, e é assim que se toma bloqueio sem fazer nada de errado de
 * propósito.
 *
 * Compilar antes:
 *   npx tsc src/core/reconciliacao.ts --outDir _tmp --target ES2022 \
 *     --module commonjs --moduleResolution node --skipLibCheck --esModuleInterop --strict
 *   echo {"type":"commonjs"} > _tmp/package.json
 *   node scripts/teste-reconciliacao.cjs
 */
const { neon } = require("@neondatabase/serverless");
const { webcrypto: wc } = require("node:crypto");
process.loadEnvFile(".env");
const sql = neon(process.env.DATABASE_URL);

let f = 0;
const eq = (l, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  if (!ok) f++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${l}` + (ok ? "" : `  obtido ${JSON.stringify(g)}, esperado ${JSON.stringify(w)}`));
};

/* Só as duas APIs externas são simuladas; o driver do banco usa o fetch real. */
const fetchReal = globalThis.fetch;
let respostaPagou = null;
let chamadasPagou = 0;
let chamadasMeta = 0;

globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("api.pagou.ai")) {
    chamadasPagou++;
    return respostaPagou;
  }
  if (u.includes("graph.facebook.com")) {
    chamadasMeta++;
    return { ok: true, status: 200, json: async () => ({ events_received: 1 }) };
  }
  return fetchReal(url, init);
};

const { reconciliar } = require("../_tmp/core/reconciliacao.js");

async function cifra(v) {
  const bytes = Uint8Array.from(atob(process.env.CREDENTIALS_KEY), (c) => c.charCodeAt(0));
  const k = await wc.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt"]);
  const iv = wc.getRandomValues(new Uint8Array(12));
  const out = await wc.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(v));
  const b = (x) => Buffer.from(x).toString("base64");
  return `${b(iv)}.${b(new Uint8Array(out))}`;
}

const min = (n) => new Date(Date.now() - n * 60_000);

(async () => {
  await sql`DELETE FROM tenants WHERE slug = 'recon-teste'`;
  const [t] = await sql`INSERT INTO tenants (name, slug) VALUES ('R','recon-teste') RETURNING id`;

  const cred = JSON.stringify({ apiKey: await cifra("chave") });
  const [conn] = await sql`INSERT INTO gateway_connections
    (tenant_id, gateway, label, credentials, webhook_secret)
    VALUES (${t.id}, 'pagou', 'Pagou', ${cred}::jsonb, ${"s" + wc.randomUUID()}) RETURNING id`;

  const credMeta = JSON.stringify({ accessToken: await cifra("tok") });
  await sql`INSERT INTO destinations (tenant_id, platform, label, external_id, credentials)
    VALUES (${t.id}, 'meta', 'Pixel', '999', ${credMeta}::jsonb)`;

  const click = wc.randomUUID();
  await sql`INSERT INTO click_sessions (click_id, tenant_id, utm_source, fbp)
    VALUES (${click}, ${t.id}, 'FB', 'fb.1.1700000000000.123456')`;

  /* Corpo de webhook do pagou.ai, com o clickId no campo de repasse. */
  const corpo = (pedidoId, status, valor) => JSON.stringify({
    id: "evt-" + pedidoId + "-" + status,
    event: "transaction." + status,
    data: {
      id: pedidoId,
      status,
      amount: valor,
      payment_method: "pix",
      customer: { name: "Joao Silva", email: "joao@ex.com", phone: "11999998888" },
      sck: click,
    },
  });

  const entrega = async (pedidoId, status, quando, processada) =>
    (await sql`INSERT INTO webhook_deliveries
      (tenant_id, gateway_connection_id, gateway_event_id, verified, raw_body, headers, received_at, processed_at)
      VALUES (${t.id}, ${conn.id}, ${"evt-" + pedidoId + "-" + status}, true,
        ${corpo(pedidoId, status, 19990)}, '{}'::jsonb, ${quando}, ${processada})
      RETURNING id`)[0].id;

  const pedidoDe = async (pedidoId) =>
    (await sql`SELECT status, gross_cents, attribution_method, click_id
       FROM orders WHERE tenant_id = ${t.id} AND gateway_order_id = ${pedidoId}`)[0];

  const disparosDe = async (pedidoId) =>
    Number((await sql`SELECT count(*) c FROM dispatches d
      JOIN orders o ON o.id = d.order_id
      WHERE o.gateway_order_id = ${pedidoId} AND o.tenant_id = ${t.id}`)[0].c);

  /* ============================================ 1. entrega travada ==== */
  console.log("\n== entrega travada é reprocessada ==");
  await entrega("TX-1", "paid", min(30), null);
  await entrega("TX-2", "paid", min(2), null);   /* recente demais */
  await entrega("TX-3", "paid", min(30), new Date()); /* já processada */

  chamadasMeta = 0;
  let r = await reconciliar(t.id);

  eq("reprocessou uma", r.entregasReprocessadas, 1);
  eq("recuperou a venda", r.vendasRecuperadas, 1);
  eq("nenhuma falhou", r.entregasFalhadas, 0);

  const tx1 = await pedidoDe("TX-1");
  eq("venda gravada", tx1.status, "paid");
  eq("valor correto", Number(tx1.gross_cents), 19990);
  eq("atribuída pelo clickId", tx1.attribution_method, "click_id");
  eq("sessão amarrada", tx1.click_id, click);
  eq("disparou para a Meta", chamadasMeta, 1);

  eq("a recente não foi tocada", await pedidoDe("TX-2"), undefined);
  eq("a já processada não foi tocada", await pedidoDe("TX-3"), undefined);

  console.log("\n== rodar de novo NÃO duplica a conversão ==");
  chamadasMeta = 0;
  r = await reconciliar(t.id);
  eq("nada a reprocessar", r.entregasReprocessadas, 0);
  eq("nenhuma chamada à Meta", chamadasMeta, 0);
  eq("continua com um disparo só", await disparosDe("TX-1"), 1);

  /* ============================================ 2. corpo ilegível ===== */
  console.log("\n== entrega com corpo ilegível fica registrada, não some ==");
  await sql`INSERT INTO webhook_deliveries
    (tenant_id, gateway_connection_id, gateway_event_id, verified, raw_body, headers, received_at)
    VALUES (${t.id}, ${conn.id}, 'evt-ruim', true, 'isto não é json', '{}'::jsonb, ${min(30)})`;

  r = await reconciliar(t.id);
  eq("contou como falha", r.entregasFalhadas, 1);
  const ruim = (await sql`SELECT processed_at, error FROM webhook_deliveries
    WHERE gateway_event_id = 'evt-ruim' AND tenant_id = ${t.id}`)[0];
  eq("segue não processada", ruim.processed_at, null);
  eq("com o erro guardado", ruim.error !== null, true);

  /* ============================================ 3. reivindicação ====== */
  console.log("\n== reivindicação órfã: pergunta ao gateway ==");
  await sql`DELETE FROM webhook_deliveries WHERE tenant_id = ${t.id}`;

  const claim = async (pedidoId, quando, consultas) =>
    sql`INSERT INTO order_claims (tenant_id, gateway, gateway_order_id, click_id, created_at, checks)
      VALUES (${t.id}, 'pagou', ${pedidoId}, ${click}, ${quando}, ${consultas ?? 0})`;

  await claim("TX-9", min(40));
  await claim("TX-8", min(5));            /* recente demais */
  await claim("TX-1", min(40));           /* já virou venda */
  await claim("TX-7", min(40), 5);        /* teto estourado */

  respostaPagou = {
    ok: true, status: 200,
    json: async () => ({ data: {
      id: "TX-9", status: "paid", amount: 24990, payment_method: "pix",
      customer: { name: "Maria Souza", email: "maria@ex.com", phone: "11988887777" },
    } }),
  };

  chamadasPagou = 0;
  chamadasMeta = 0;
  r = await reconciliar(t.id);

  eq("consultou só a órfã madura", r.reivindicacoesConsultadas, 1);
  eq("uma chamada ao gateway", chamadasPagou, 1);
  eq("recuperou a venda", r.vendasRecuperadas, 1);

  const tx9 = await pedidoDe("TX-9");
  eq("venda recuperada", tx9.status, "paid");
  eq("valor da API", Number(tx9.gross_cents), 24990);
  eq("atribuída pela reivindicação", tx9.attribution_method, "order_claim");
  eq("disparou para a Meta", chamadasMeta, 1);

  console.log("\n== venda recuperada para de ser consultada ==");
  await sql`UPDATE order_claims SET checked_at = ${min(120)} WHERE tenant_id = ${t.id}`;
  chamadasPagou = 0;
  r = await reconciliar(t.id);
  eq("não perguntou de novo pela TX-9", chamadasPagou, 0);
  eq("continua com um disparo só", await disparosDe("TX-9"), 1);

  /* ============================================ 4. carrinho abandonado */
  console.log("\n== pedido que não existe no gateway para de ser consultado ==");
  await claim("TX-404", min(40));
  respostaPagou = { ok: false, status: 404, json: async () => ({}) };

  chamadasPagou = 0;
  r = await reconciliar(t.id);
  eq("perguntou uma vez", chamadasPagou, 1);
  eq("não recuperou nada", r.vendasRecuperadas, 0);

  const abandonado = (await sql`SELECT checks FROM order_claims
    WHERE gateway_order_id = 'TX-404' AND tenant_id = ${t.id}`)[0];
  eq("teto zerado de uma vez", abandonado.checks, 5);

  await sql`UPDATE order_claims SET checked_at = ${min(120)} WHERE tenant_id = ${t.id}`;
  chamadasPagou = 0;
  await reconciliar(t.id);
  eq("nunca mais perguntou", chamadasPagou, 0);

  /* ============================================ 5. gateway instável === */
  console.log("\n== gateway fora do ar: conta a tentativa, não desiste ==");
  await claim("TX-500", min(40));
  respostaPagou = { ok: false, status: 500, json: async () => ({}) };

  chamadasPagou = 0;
  r = await reconciliar(t.id);
  eq("perguntou", chamadasPagou, 1);
  eq("não recuperou", r.vendasRecuperadas, 0);

  const instavel = (await sql`SELECT checks FROM order_claims
    WHERE gateway_order_id = 'TX-500' AND tenant_id = ${t.id}`)[0];
  eq("gastou uma tentativa das cinco", instavel.checks, 1);

  /* Sem esperar a hora, não pergunta de novo. */
  chamadasPagou = 0;
  await reconciliar(t.id);
  eq("respeitou o intervalo", chamadasPagou, 0);

  await sql`DELETE FROM tenants WHERE slug = 'recon-teste'`;
  console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
  process.exit(f === 0 ? 0 : 1);
})();
