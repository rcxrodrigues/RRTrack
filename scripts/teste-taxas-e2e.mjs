/*
 * A taxa certa, do gateway certo, na venda certa.
 *
 * A pergunta que este teste responde é "como o sistema sabe qual taxa é de
 * qual?". A resposta é uma cadeia de três elos, e qualquer um deles quebrado
 * produz taxa errada sem erro nenhum:
 *
 *   1. a venda carrega a CONEXÃO por onde entrou, e cada conexão tem a sua
 *      tabela — venda da Appmax nunca é cobrada com a tabela da Millions;
 *   2. o adaptador normaliza o MÉTODO (pix, credit_card) a partir de formatos
 *      completamente diferentes em cada gateway;
 *   3. o adaptador extrai as PARCELAS, e é o número delas que escolhe a faixa.
 *
 * O elo 3 é o mais frágil: se as parcelas se perdem, tudo vira 1x. Numa venda
 * de R$ 100 em 12x pela Appmax isso cobra R$ 3,98 em vez de R$ 13,89.
 */
import { neon } from "@neondatabase/serverless";
import { webcrypto as wc } from "node:crypto";

process.loadEnvFile(".env");
const sql = neon(process.env.DATABASE_URL);
const BASE = process.env.RR_BASE || "http://localhost:3000";
const seed = JSON.parse(process.argv[2]);

let f = 0;
const ok = (l, c, e = "") => { if (!c) f++; console.log(`  ${c ? "ok  " : "FALHA"} | ${l}${e ? "  → " + e : ""}`); };
const brl = (c) => c === null ? "sem taxa" : "R$ " + (c / 100).toFixed(2).replace(".", ",");

const APPMAX_FIXO = 99, MILLIONS_FIXO = 499;

const TABELAS = {
  appmax: {
    pix: { percentual: 1.49, fixoCents: APPMAX_FIXO },
    credit_card: [
      [1, 2.99], [2, 4.79], [3, 5.39], [4, 5.89], [5, 6.29], [6, 6.99],
      [7, 7.89], [8, 8.69], [9, 9.54], [10, 10.10], [11, 11.68], [12, 12.90],
    ].map(([ateParcelas, percentual]) => ({ ateParcelas, percentual, fixoCents: APPMAX_FIXO })),
  },
  millions: {
    pix: { percentual: 2.99, fixoCents: 310 },
    credit_card: [
      [1, 6.92], [2, 8.98], [3, 10.19], [4, 11.49], [5, 12.79], [6, 14.09],
      [7, 15.39], [8, 16.69], [9, 18.19], [10, 20.53], [11, 22.10], [12, 23.60],
    ].map(([ateParcelas, percentual]) => ({ ateParcelas, percentual, fixoCents: MILLIONS_FIXO })),
  },
};

/* Grava as tabelas nas conexões desta semente, não nas de produção. */
for (const [gateway, tabela] of Object.entries(TABELAS)) {
  await sql`
    UPDATE gateway_connections SET fees = ${JSON.stringify(tabela)}::jsonb
    WHERE id = ${seed.gateways[gateway].connectionId}`;
}


/*
 * A MillionsPay assina com o segredo QUE ELA gera ao criar o endpoint, e nao
 * com o segredo do caminho da nossa URL. Sao valores sem relacao, e o teste
 * precisa cadastrar um e assinar com ele — assinar com o da URL validaria a
 * implementacao contra ela mesma, que foi como o bug passou.
 */
const SEGREDO_MILLIONS = "whsk_" + Buffer.from(wc.getRandomValues(new Uint8Array(16))).toString("hex");

async function cadastrarSegredoDeAssinatura() {
  const { neon } = await import("@neondatabase/serverless");
  process.loadEnvFile(".env");
  const sql = neon(process.env.DATABASE_URL);

  /* Mesma cifragem do src/core/crypto.ts: AES-256-GCM, formato "iv.dados". */
  const bytes = Uint8Array.from(atob(process.env.CREDENTIALS_KEY), (c) => c.charCodeAt(0));
  const key = await wc.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt"]);
  const iv = wc.getRandomValues(new Uint8Array(12));
  const out = await wc.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(SEGREDO_MILLIONS));
  const b64 = (b) => btoa(String.fromCharCode(...b));
  const cifrado = `${b64(iv)}.${b64(new Uint8Array(out))}`;

  await sql`UPDATE gateway_connections SET credentials = ${JSON.stringify({ signingSecret: cifrado })}::jsonb
    WHERE id = ${seed.gateways.millions.connectionId}`;
}
await cadastrarSegredoDeAssinatura();

const enviar = (gw, corpo, headers = {}) =>
  fetch(`${BASE}/api/webhook/${gw}/${seed.gateways[gw].webhookSecret}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(corpo),
  });

const taxaDe = async (id) => {
  const [o] = await sql`SELECT fee_cents, payment_method, installments FROM orders WHERE gateway_order_id = ${String(id)}`;
  return o ? { taxa: o.fee_cents === null ? null : Number(o.fee_cents), metodo: o.payment_method, parcelas: o.installments } : null;
};

/* ------------------------------------------------------------- APPMAX -- */
console.log("\nAPPMAX — 1,49% no pix, por parcela exata no cartão, R$ 0,99 fixo");

async function appmax(id, metodo, parcelas) {
  await enviar("appmax", {
    event: "order_approved", event_type: "order",
    data: {
      order_id: id, status: "aprovado", total: 10000,
      paid_at: "2026-08-25 10:00:00", created_at: "2026-08-25 09:59:00",
      products: [{ sku: "P1", name: "Produto", price: 10000, quantity: 1 }],
      payment_info: metodo === "pix"
        ? { pix: { captured_at: "2026-08-25 10:00:00" } }
        : { credit_card: { installments: parcelas, captured_at: "2026-08-25 10:00:00" } },
    },
  });
  return taxaDe(id);
}

const aPix = await appmax(810001 + Math.floor(Math.random() * 9000), "pix");
ok("pix reconhecido", aPix?.metodo === "pix", aPix?.metodo);
ok("pix: 1,49% + R$ 0,99 = R$ 2,48", aPix?.taxa === 248, brl(aPix?.taxa));

const a1 = await appmax(820001 + Math.floor(Math.random() * 9000), "cartao", 1);
ok("cartão 1x reconhecido", a1?.parcelas === 1, String(a1?.parcelas));
ok("1x: 2,99% + R$ 0,99 = R$ 3,98", a1?.taxa === 398, brl(a1?.taxa));

const a6 = await appmax(830001 + Math.floor(Math.random() * 9000), "cartao", 6);
ok("cartão 6x reconhecido", a6?.parcelas === 6, String(a6?.parcelas));
ok("6x: 6,99% + R$ 0,99 = R$ 7,98", a6?.taxa === 798, brl(a6?.taxa));

const a12 = await appmax(840001 + Math.floor(Math.random() * 9000), "cartao", 12);
ok("cartão 12x reconhecido", a12?.parcelas === 12, String(a12?.parcelas));
ok("12x: 12,90% + R$ 0,99 = R$ 13,89", a12?.taxa === 1389, brl(a12?.taxa));

/*
 * O elo frágil: se as parcelas se perdessem, 12x cobraria como 1x. A diferença
 * é de quase quatro vezes, e sairia como lucro a mais no painel.
 */
ok("parcelas mudam a taxa de verdade", a12?.taxa !== a1?.taxa,
  `1x ${brl(a1?.taxa)} vs 12x ${brl(a12?.taxa)}`);

/* ----------------------------------------------------------- MILLIONS -- */
console.log("\nMILLIONS — outro formato de payload, outra tabela");

async function millions(id, metodo, parcelas) {
  const corpo = {
    id: wc.randomUUID(), event: "charge.captured",
    charge: {
      id, status: "captured", amount: 10000, total_amount: 10000, currency: "BRL",
      payment_method: metodo, installments: parcelas ?? 1,
      customer: { name: "Teste", email: "t@exemplo.com" },
      captured_at: new Date().toISOString(), created_at: new Date().toISOString(),
    },
    occurred_at: new Date().toISOString(),
  };
  const texto = JSON.stringify(corpo);
  const { createHmac } = await import("node:crypto");
  const assinatura = "sha256=" + createHmac("sha256", SEGREDO_MILLIONS).update(texto).digest("hex");
  await fetch(`${BASE}/api/webhook/millions/${seed.gateways.millions.webhookSecret}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-soarlabz-signature": assinatura },
    body: texto,
  });
  return taxaDe(id);
}

const mPix = await millions(wc.randomUUID(), "pix");
ok("pix reconhecido", mPix?.metodo === "pix", mPix?.metodo);
ok("pix: 2,99% + R$ 3,10 = R$ 6,09", mPix?.taxa === 609, brl(mPix?.taxa));

const m6 = await millions(wc.randomUUID(), "credit_card", 6);
ok("cartão 6x reconhecido", m6?.parcelas === 6, String(m6?.parcelas));
ok("6x: 14,09% + R$ 4,99 = R$ 19,08", m6?.taxa === 1908, brl(m6?.taxa));

/* ------------------------------------------------ a tabela é da conexão -- */
console.log("\nCADA VENDA COBRA PELA TABELA DA SUA CONEXÃO");
ok("mesmo método, taxas diferentes", aPix?.taxa !== mPix?.taxa,
  `appmax ${brl(aPix?.taxa)} vs millions ${brl(mPix?.taxa)}`);
ok("mesmo parcelamento, taxas diferentes", a6?.taxa !== m6?.taxa,
  `appmax ${brl(a6?.taxa)} vs millions ${brl(m6?.taxa)}`);

/* ------------------------------------- o gateway que informa tem razão -- */
console.log("\nQUANDO O GATEWAY INFORMA, A TABELA NÃO É CONSULTADA");

const trx = "trx_" + Buffer.from(wc.getRandomValues(new Uint8Array(6))).toString("hex");
await enviar("pagou", {
  id: "evt_" + Date.now(), event: "transaction.paid",
  data: {
    id: trx, status: "paid", amount: 10000, currency: "BRL",
    payment_method: "pix", fee: 777,
    paid_at: new Date().toISOString(),
    customer: { name: "Teste", email: "t@exemplo.com" },
  },
});
const p = await taxaDe(trx);
ok("usa a taxa do webhook", p?.taxa === 777, brl(p?.taxa));

/*
 * E sem tabela nem taxa informada, fica NULO — não zero. Zero afirmaria que o
 * gateway não cobrou nada, e o painel declararia lucro que não existe.
 */
await sql`UPDATE gateway_connections SET fees = '{}'::jsonb WHERE id = ${seed.gateways.pagou.connectionId}`;
const trx2 = "trx_" + Buffer.from(wc.getRandomValues(new Uint8Array(6))).toString("hex");
await enviar("pagou", {
  id: "evt2_" + Date.now(), event: "transaction.paid",
  data: {
    id: trx2, status: "paid", amount: 10000, currency: "BRL",
    payment_method: "pix", paid_at: new Date().toISOString(),
    customer: { name: "Teste", email: "t@exemplo.com" },
  },
});
const p2 = await taxaDe(trx2);
ok("sem tabela e sem taxa: nulo, não zero", p2?.taxa === null, brl(p2?.taxa));

console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
process.exit(f === 0 ? 0 : 1);
