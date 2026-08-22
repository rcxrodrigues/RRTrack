/*
 * Prova que uma loja cadastrada pelo scripts/cadastrar.mjs recebe venda de
 * verdade em produção: coletor, webhook assinado, junção, disparo e — o que
 * mais importa num sistema multi-loja — que nada vazou para a loja vizinha.
 *
 * Roda contra a loja de slug 'loja-teste'.
 */
import { neon } from "@neondatabase/serverless";
import { webcrypto as wc, createHmac } from "node:crypto";
process.loadEnvFile(".env");
const sql = neon(process.env.DATABASE_URL);
const BASE = "https://rr-track.vercel.app";

const [t] = await sql`SELECT id FROM tenants WHERE slug = 'loja-teste'`;
const [s] = await sql`SELECT public_key FROM sites WHERE tenant_id = ${t.id}`;
const conns = await sql`SELECT gateway, webhook_secret FROM gateway_connections WHERE tenant_id = ${t.id}`;
const seg = Object.fromEntries(conns.map(c => [c.gateway, c.webhook_secret]));

let falhas = 0;
const check = (l, ok, e = "") => { if (!ok) falhas++; console.log(`  ${ok ? "ok  " : "FALHA"} | ${l}${e ? "  → " + e : ""}`); };

/* 1. clique */
const clickId = wc.randomUUID();
const r1 = await fetch(`${BASE}/rr/collect`, {
  method: "POST",
  headers: { "content-type": "text/plain", "user-agent": "Mozilla/5.0 (iPhone)" },
  body: JSON.stringify({
    site_key: s.public_key, click_id: clickId, external_id: wc.randomUUID(),
    event: "page_view", event_id: "pv." + clickId,
    attribution: { utm_source: "facebook", utm_campaign: "loja-nova", fbclid: "IwARnova" },
    fbp: "fb.1." + Date.now() + ".5544332211",
    fbc: "fb.1." + Date.now() + ".IwARnova",
    page_url: "https://lojateste.com.br/", occurred_at: new Date().toISOString(),
  }),
});
check("coletor aceita a chave nova", r1.status === 204, `status ${r1.status}`);

/* 2. venda pela Millions, assinada */
const cobranca = wc.randomUUID();
const corpo = JSON.stringify({
  id: wc.randomUUID(), event: "charge.captured",
  charge: {
    id: cobranca, status: "captured", amount: 19900, total_amount: 19900,
    currency: "BRL", payment_method: "pix", installments: 1,
    customer: { name: "Ana Paula Souza", email: "ANA.souza@gmail.com", tax_id: "11144477735", phone: "(31) 98765-4321" },
    metadata: { rr_click_id: clickId },
    captured_at: new Date().toISOString(), created_at: new Date().toISOString(),
  },
  occurred_at: new Date().toISOString(),
});
const assinatura = "sha256=" + createHmac("sha256", seg.millions).update(corpo).digest("hex");

const r2 = await fetch(`${BASE}/api/webhook/millions/${seg.millions}`, {
  method: "POST", headers: { "content-type": "application/json", "x-soarlabz-signature": assinatura }, body: corpo,
});
const j2 = await r2.json();
check("webhook da loja nova aceito", r2.status === 200, `status ${r2.status}`);
check("assinatura verificada", j2.verificado === true);
check("atribuído pelo clickId", j2.atribuicao === "click_id", j2.atribuicao);

/* 3. venda e disparo no banco, isolados na loja certa */
const [v] = await sql`SELECT * FROM orders WHERE gateway_order_id = ${cobranca}`;
check("venda gravada", !!v);
check("pertence à loja nova", v?.tenant_id === t.id);
check("valor certo", Number(v?.gross_cents) === 19900, String(v?.gross_cents));

const [d] = await sql`SELECT * FROM dispatches WHERE order_id = ${v?.id}`;
check("disparo para o pixel da loja nova", !!d);
console.log("     chaves: " + (d?.match_keys ?? []).join(", "));
check("dez chaves", (d?.match_keys ?? []).length === 10, String((d?.match_keys ?? []).length));

const dest = await sql`SELECT external_id, test_event_code FROM destinations WHERE id = ${d?.destination_id}`;
check("pixel correto", dest[0]?.external_id === "1122334455667788", dest[0]?.external_id);
check("código de teste aplicado", d?.request_body?.test_event_code === "TEST12345", String(d?.request_body?.test_event_code));

/* 4. isolamento entre lojas */
const [flore] = await sql`SELECT id FROM tenants WHERE slug = 'flore'`;
const [{ count: vazamento }] = await sql`
  SELECT count(*)::int FROM orders WHERE gateway_order_id = ${cobranca} AND tenant_id = ${flore.id}`;
check("nada vazou para a outra loja", vazamento === 0);

console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " FALHA(S)") + "\n");
process.exit(falhas === 0 ? 0 : 1);
