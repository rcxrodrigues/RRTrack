/*
 * Teste ponta a ponta: um clique vira sessão, uma venda chega pelo webhook,
 * a junção acontece e o disparo é montado com as chaves de correspondência.
 */
import { neon } from "@neondatabase/serverless";
import { webcrypto as wc } from "node:crypto";

process.loadEnvFile(".env");
const sql = neon(process.env.DATABASE_URL);
const BASE = "http://localhost:3000";

const seed = JSON.parse(process.argv[2]);
const CLICK_ID = wc.randomUUID();
const TRX = "trx_" + Buffer.from(wc.getRandomValues(new Uint8Array(6))).toString("hex");

let falhas = 0;
const check = (label, ok, extra = "") => {
  if (!ok) falhas++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${label}${extra ? "  → " + extra : ""}`);
};

/* ---------------------------------------------------- 1. o clique ------- */
console.log("\n1. navegador manda o beacon para o coletor");

const beacon = {
  site_key: seed.siteKey,
  click_id: CLICK_ID,
  external_id: wc.randomUUID(),
  event: "page_view",
  event_id: "pv." + CLICK_ID,
  attribution: {
    utm_source: "facebook",
    utm_medium: "cpc",
    utm_campaign: "carimbo-publico-frio",
    utm_content: "criativo-video-03",
    fbclid: "IwAR2xTestFbclid0099",
    landing_url: "https://www.florecomesticos.store/?utm_source=facebook",
  },
  fbp: "fb.1." + Date.now() + ".1234567890",
  fbc: "fb.1." + Date.now() + ".IwAR2xTestFbclid0099",
  page_url: "https://www.florecomesticos.store/",
  occurred_at: new Date().toISOString(),
};

const r1 = await fetch(`${BASE}/rr/collect`, {
  method: "POST",
  headers: { "content-type": "text/plain", "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)" },
  body: JSON.stringify(beacon),
});
check("coletor responde 204", r1.status === 204, `status ${r1.status}`);

const [sessao] = await sql`SELECT * FROM click_sessions WHERE click_id = ${CLICK_ID}`;
check("sessão de clique gravada", !!sessao);
check("campanha preservada", sessao?.utm_campaign === "carimbo-publico-frio", sessao?.utm_campaign);
check("fbc guardado", !!sessao?.fbc);
check("user-agent capturado", !!sessao?.user_agent);

/* ------------------------------------------- 2. a venda pelo webhook ---- */
console.log("\n2. gateway manda a venda, com o clickId de volta no sck");

const payload = {
  id: "evt_" + Buffer.from(wc.getRandomValues(new Uint8Array(6))).toString("hex"),
  event: "transaction.paid",
  api_version: "v2",
  data: {
    id: TRX,
    status: "paid",
    amount: 8970,
    currency: "BRL",
    payment_method: "pix",
    paid_at: new Date().toISOString(),
    customer: {
      /* Sujo de propósito: espaço, maiúscula e telefone formatado. */
      name: "José da Silva Santos",
      email: "  Jose.Silva@Gmail.COM ",
      phone: "(11) 98765-4321",
    },
    products: [
      { external_id: "1313", name: "Carimbo de Delineador", quantity: 1, unit_price: 8970 },
    ],
    attribution: {
      utm_source: "facebook",
      utm_medium: "cpc",
      utm_campaign: "carimbo-publico-frio",
      sck: CLICK_ID,
    },
  },
};

const url = `${BASE}/api/webhook/pagou/${seed.webhookSecret}`;
const r2 = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
const j2 = await r2.json();

check("webhook aceito", r2.status === 200, `status ${r2.status}`);
check("atribuído pelo clickId", j2.atribuicao === "click_id", j2.atribuicao);
check("marcado como não verificado", j2.verificado === false);

/* ------------------------------------------------- 3. a venda no banco -- */
console.log("\n3. a venda no banco");

const [venda] = await sql`SELECT * FROM orders WHERE gateway_order_id = ${TRX}`;
check("venda gravada", !!venda);
check("status pago", venda?.status === "paid", venda?.status);
check("valor em centavos", Number(venda?.gross_cents) === 8970, String(venda?.gross_cents));
check("ligada à sessão de clique", venda?.click_id === CLICK_ID);

const itens = await sql`SELECT * FROM order_items WHERE order_id = ${venda?.id}`;
check("item gravado com SKU", itens[0]?.sku === "1313", itens[0]?.sku);

/* ---------------------------------------------------- 4. o disparo ------ */
console.log("\n4. o disparo para a Meta");

const [disp] = await sql`SELECT * FROM dispatches WHERE order_id = ${venda?.id}`;
check("disparo registrado", !!disp);
check("event_id é o id da venda", disp?.event_id === TRX);

const chaves = disp?.match_keys ?? [];
console.log("     chaves enviadas: " + chaves.join(", "));
check("nove chaves de correspondência", chaves.length === 9, String(chaves.length));

for (const k of ["em", "ph", "fn", "ln", "fbp", "fbc", "external_id", "ip", "user_agent"]) {
  check(`  chave ${k} presente`, chaves.includes(k));
}

/* Confere que a normalização foi aplicada antes do hash. */
const ud = disp?.request_body?.data?.[0]?.user_data;
const esperadoEmail = Buffer.from(
  await wc.subtle.digest("SHA-256", new TextEncoder().encode("jose.silva@gmail.com")),
).toString("hex");
check("e-mail normalizado antes do hash", ud?.em?.[0] === esperadoEmail);

const esperadoTel = Buffer.from(
  await wc.subtle.digest("SHA-256", new TextEncoder().encode("5511987654321")),
).toString("hex");
check("telefone com DDI antes do hash", ud?.ph?.[0] === esperadoTel);
check("nenhum dado pessoal em claro", JSON.stringify(ud).indexOf("gmail") === -1);
check("falhou no envio (token falso, esperado)", disp?.status === "failed", disp?.error ?? "");

/* -------------------------------------------------- 5. reentregas ------- */
console.log("\n5. defesas contra reentrega");

const r3 = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
const j3 = await r3.json();
check("webhook repetido é ignorado", j3.duplicado === true);

const [{ count: nDisp }] = await sql`SELECT count(*)::int FROM dispatches WHERE order_id = ${venda?.id}`;
check("continua com um disparo só", nDisp === 1, String(nDisp));

/* Um "pending" atrasado não pode reabrir uma venda já paga. */
const atrasado = structuredClone(payload);
atrasado.id = "evt_atrasado_" + Date.now();
atrasado.event = "transaction.pending";
atrasado.data.status = "pending";

const r4 = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(atrasado) });
const j4 = await r4.json();
check("estado não retrocede", j4.estado_ignorado === "pending", JSON.stringify(j4));

const [vendaDepois] = await sql`SELECT status FROM orders WHERE gateway_order_id = ${TRX}`;
check("venda continua paga", vendaDepois?.status === "paid", vendaDepois?.status);

/* Segredo errado não entra. */
const r5 = await fetch(`${BASE}/api/webhook/pagou/whsec_errado`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
});
check("segredo errado é rejeitado", r5.status === 404, `status ${r5.status}`);

/* Chave de site inválida não coleta. */
const r6 = await fetch(`${BASE}/rr/collect`, {
  method: "POST", headers: { "content-type": "text/plain" },
  body: JSON.stringify({ ...beacon, site_key: "pk_invalida", click_id: wc.randomUUID() }),
});
check("site desconhecido é rejeitado", r6.status === 403, `status ${r6.status}`);

console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " FALHA(S)") + "\n");
process.exit(falhas === 0 ? 0 : 1);
