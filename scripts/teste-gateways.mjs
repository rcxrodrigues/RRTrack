/*
 * Teste dos três gateways.
 *
 * Não é sobre o circuito funcionar — disso cuida o teste ponta a ponta. É
 * sobre cada dialeto chegar ao mesmo formato canônico, e sobre as diferenças
 * entre os gateways aparecerem exatamente onde deveriam.
 *
 * Os payloads aqui seguem a estrutura publicada na documentação de cada um,
 * não uma estrutura conveniente. Foi justamente ao conferir isso que ficou
 * claro que o webhook da Appmax não traz comprador nenhum.
 */
import { neon } from "@neondatabase/serverless";
import { webcrypto as wc, createHmac } from "node:crypto";

process.loadEnvFile(".env");
const sql = neon(process.env.DATABASE_URL);
/* Aponta para produção com RR_BASE=https://... ; local por padrão. */
const BASE = process.env.RR_BASE || "http://localhost:3000";
const seed = JSON.parse(process.argv[2]);

let falhas = 0;
const check = (label, ok, extra = "") => {
  if (!ok) falhas++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${label}${extra ? "  → " + extra : ""}`);
};

const hash = async (v) => Buffer.from(
  await wc.subtle.digest("SHA-256", new TextEncoder().encode(v)),
).toString("hex");

async function novaSessao() {
  const clickId = wc.randomUUID();
  await fetch(`${BASE}/rr/collect`, {
    method: "POST",
    headers: { "content-type": "text/plain", "user-agent": "Mozilla/5.0 (Linux; Android 14)" },
    body: JSON.stringify({
      site_key: seed.siteKey,
      click_id: clickId,
      external_id: wc.randomUUID(),
      event: "page_view",
      event_id: "pv." + clickId,
      attribution: { utm_source: "facebook", utm_campaign: "teste-multi-gateway" },
      fbp: "fb.1." + Date.now() + ".9988776655",
      fbc: "fb.1." + Date.now() + ".IwARmultigateway",
      page_url: "https://loja.exemplo.com.br/",
      occurred_at: new Date().toISOString(),
    }),
  });
  return clickId;
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
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: corpo,
  });

/* ==================================================== APPMAX ============= */
console.log("\nAPPMAX — o gateway que não devolve nada");

const clickAppmax = await novaSessao();
const pedidoAppmax = 700000 + Math.floor(Math.random() * 99999);

/*
 * Sem campo de repasse no webhook, a loja precisa avisar quem é o dono do
 * pedido no momento em que o cria. É o que esta chamada faz.
 */
const rClaim = await fetch(`${BASE}/api/claim`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    site_key: seed.siteKey,
    click_id: clickAppmax,
    gateway: "appmax",
    gateway_order_id: pedidoAppmax,
  }),
});
const jClaim = await rClaim.json();
check("reivindicação aceita", rClaim.status === 200, `status ${rClaim.status}`);
check("registro novo", jClaim.novo === true);

/* Estrutura conforme docs.appmax.com.br/guides/webhooks — pedido em `data`. */
const corpoAppmax = JSON.stringify({
  event: "order_approved",
  event_type: "order",
  site_id: wc.randomUUID(),
  app_id: wc.randomUUID(),
  client_key: "merchant-key-123",
  external_key: "ext-order-456",
  data: {
    order_id: pedidoAppmax,
    status: "aprovado",
    total: 25990,
    freight_value: 1500,
    merchant_total: 23400,
    discount: 0,
    interest: 0,
    paid_at: "2026-08-22 14:30:00",
    created_at: "2026-08-22 14:28:00",
    products: [
      { sku: "PROD-001", name: "Curso de Marketing Digital", price: 25990, quantity: 1 },
    ],
    payment_info: {
      credit_card: {
        installments: 3, card_brand: "visa",
        authorization_code: "AUTH9876", captured_at: "2026-08-22 14:30:00",
      },
    },
    notification_type: "order_approved",
  },
});

const rA = await enviar("appmax", corpoAppmax);
const jA = await rA.json();
check("webhook aceito", rA.status === 200, `status ${rA.status}`);
check("atribuído pela reivindicação", jA.atribuicao === "order_claim", jA.atribuicao);

const [vA] = await sql`SELECT * FROM orders WHERE gateway_order_id = ${String(pedidoAppmax)}`;
check("venda gravada e paga", vA?.status === "paid", vA?.status);
check("total lido de data.total", Number(vA?.gross_cents) === 25990, String(vA?.gross_cents));
check("frete de freight_value", Number(vA?.shipping_cents) === 1500, String(vA?.shipping_cents));
check("parcelas de payment_info", vA?.installments === 3, String(vA?.installments));
check("método do cartão", vA?.payment_method === "credit_card", vA?.payment_method);

const itensA = await sql`SELECT * FROM order_items WHERE order_id = ${vA?.id}`;
check("produto extraído", itensA[0]?.sku === "PROD-001", itensA[0]?.sku);

const [dA] = await sql`SELECT * FROM dispatches WHERE order_id = ${vA?.id}`;
const chavesA = dA?.match_keys ?? [];
console.log("     chaves: " + chavesA.join(", "));
/*
 * Só chaves de navegador. Sem credencial de API configurada, o enrich não roda
 * e não há comprador nenhum para hashear — que é exatamente o ponto: na Appmax
 * o dado da pessoa não vem de graça.
 */
check("cinco chaves, todas de navegador", chavesA.length === 5, String(chavesA.length));
check("sem e-mail", !chavesA.includes("em"));
check("sem telefone", !chavesA.includes("ph"));
for (const k of ["fbp", "fbc", "ip", "user_agent", "external_id"]) {
  check(`  chave ${k}`, chavesA.includes(k));
}

/* ================================================== MILLIONS ============ */
console.log("\nMILLIONS — assinatura de verdade e metadata livre");

const clickMillions = await novaSessao();
const cobranca = wc.randomUUID();

const corpoMillions = JSON.stringify({
  id: wc.randomUUID(),
  event: "charge.captured",
  charge: {
    id: cobranca,
    external_id: "loja-pedido-4477",
    status: "captured",
    amount: 14900,
    shipping_amount: 0,
    total_amount: 14900,
    currency: "BRL",
    payment_method: "pix",
    installments: 1,
    customer: {
      name: "João da Silva",
      email: "joao@exemplo.com",
      tax_id: "98765432100",
      phone: "11999998888",
      type: "individual",
    },
    /* metadata é aceito na criação da cobrança e volta intacto. */
    metadata: { rr_click_id: clickMillions, order_id: "ABC-123" },
    captured_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  },
  occurred_at: new Date().toISOString(),
});

const assinar = (corpo, segredo) =>
  "sha256=" + createHmac("sha256", segredo).update(corpo).digest("hex");
const assinatura = assinar(corpoMillions, SEGREDO_MILLIONS);

const rM = await enviar("millions", corpoMillions, { "x-soarlabz-signature": assinatura });
const jM = await rM.json();
check("assinatura válida aceita", rM.status === 200, `status ${rM.status}`);
check("marcado como VERIFICADO", jM.verificado === true);
check("clickId achado no metadata", jM.atribuicao === "click_id", jM.atribuicao);

const [vM] = await sql`SELECT * FROM orders WHERE gateway_order_id = ${cobranca}`;
check("venda gravada e paga", vM?.status === "paid", vM?.status);
check("valor em centavos", Number(vM?.gross_cents) === 14900, String(vM?.gross_cents));
check("método pix", vM?.payment_method === "pix", vM?.payment_method);

const [dM] = await sql`SELECT * FROM dispatches WHERE order_id = ${vM?.id}`;
const chavesM = dM?.match_keys ?? [];
console.log("     chaves: " + chavesM.join(", "));
check("dez chaves", chavesM.length === 10, String(chavesM.length));
check("sem CEP (Millions não manda endereço)", !chavesM.includes("zp"));

const udM = dM?.request_body?.data?.[0]?.user_data;
check("CPF virou external_id", udM?.external_id?.includes(await hash("98765432100")));
check("dois external_id", udM?.external_id?.length === 2, String(udM?.external_id?.length));
check("telefone normalizado com DDI", udM?.ph?.[0] === await hash("5511999998888"));

console.log("\n  defesas da assinatura");

const rBad = await enviar("millions", corpoMillions, {
  "x-soarlabz-signature": assinar(corpoMillions, "segredo-do-atacante"),
});
check("segredo errado rejeitado", rBad.status === 401, `status ${rBad.status}`);

const adulterado = corpoMillions.replace('"total_amount":14900', '"total_amount":1');
if (adulterado === corpoMillions) throw new Error("o teste nao adulterou nada");
const rTamper = await enviar("millions", adulterado, { "x-soarlabz-signature": assinatura });
check("corpo adulterado rejeitado", rTamper.status === 401, `status ${rTamper.status}`);

const rSem = await enviar("millions", corpoMillions);
check("sem assinatura rejeitada", rSem.status === 401, `status ${rSem.status}`);

/* ============================================ DEFESAS DA REIVINDICAÇÃO == */
console.log("\nREIVINDICAÇÃO — o que ela não deixa fazer");

/* Sessão de outra loja não pode ser amarrada. */
const rForaSessao = await fetch(`${BASE}/api/claim`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    site_key: seed.siteKey, click_id: wc.randomUUID(),
    gateway: "appmax", gateway_order_id: 999111,
  }),
});
check("sessão inexistente rejeitada", rForaSessao.status === 404, `status ${rForaSessao.status}`);

/* Segunda reivindicação do mesmo pedido não sobrescreve a primeira. */
const outraSessao = await novaSessao();
const rRoubo = await fetch(`${BASE}/api/claim`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    site_key: seed.siteKey, click_id: outraSessao,
    gateway: "appmax", gateway_order_id: pedidoAppmax,
  }),
});
const jRoubo = await rRoubo.json();
check("segunda reivindicação não sobrescreve", jRoubo.novo === false);

const [claimFinal] = await sql`
  SELECT click_id FROM order_claims WHERE gateway_order_id = ${String(pedidoAppmax)}`;
check("dono continua sendo o primeiro", claimFinal?.click_id === clickAppmax);

/* Chave de site inválida não reivindica. */
const rSemChave = await fetch(`${BASE}/api/claim`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    site_key: "pk_invalida", click_id: clickAppmax,
    gateway: "appmax", gateway_order_id: 555222,
  }),
});
check("site desconhecido rejeitado", rSemChave.status === 403, `status ${rSemChave.status}`);

/* ================================================= ISOLAMENTO =========== */
/* ==================================================== PAGOU.AI ========== */
console.log("\nPAGOU.AI — payload real, com os nomes que ele usa de verdade");

/*
 * Copiado de uma venda que aconteceu. Cada campo aqui ja custou um numero
 * errado no painel:
 *
 *   method        e nao payment_method  -> tudo caia em "other"
 *   paid_amount   e nao amount          -> venda de R$ 5,00 virava R$ 4,75
 *   fee           e objeto, nao numero  -> taxa lida como zero, e zero
 *                                          informado pelo gateway vence a
 *                                          tabela, entao nem ela entrava
 */
const trxReal = "trx_" + Buffer.from(wc.getRandomValues(new Uint8Array(6))).toString("hex");
const rP = await enviar("pagou", JSON.stringify({
  api_version: "v2",
  id: "evt_" + Date.now(),
  event: "transaction",
  data: {
    id: trxReal,
    method: "pix",
    status: "paid",
    amount: 475,
    fee: { net_amount: 188, estimated_fee: 287, spread_percentage: null },
    currency: "BRL",
    installments: 1,
    paid_amount: "500",
    paid_at: new Date().toISOString(),
    customer: { name: "RYAN XAVIER", email: "r@exemplo.com", phone: "5531984105010" },
    products: [{ title: "Carimbo", unit_price: 500, quantity: 1 }],
    attribution: { sck: null, src: null, utm_source: null },
  },
}));
check("webhook aceito", rP.status === 200, "status " + rP.status);

const [vP] = await sql`SELECT * FROM orders WHERE gateway_order_id = ${trxReal}`;
check("metodo pix, nao other", vP?.payment_method === "pix", vP?.payment_method);
check("faturamento e o paid_amount", Number(vP?.gross_cents) === 500, String(vP?.gross_cents));
/* 500 pago - 188 creditado = 312 que ficam com o gateway. */
check("taxa e o que o gateway retem", Number(vP?.fee_cents) === 312, String(vP?.fee_cents));
check("lucro bate com o painel deles", 500 - Number(vP?.fee_cents) === 188, "R$ 1,88");

/* Sem sck nem src preenchidos, a venda entra orfa — e isso e o esperado. */
check("sem repasse, fica sem atribuicao", vP?.attribution_method === "unattributed", vP?.attribution_method);


console.log("\nISOLAMENTO");

const rCruzado = await fetch(
  `${BASE}/api/webhook/appmax/${seed.gateways.pagou.webhookSecret}`,
  { method: "POST", headers: { "content-type": "application/json" }, body: corpoAppmax },
);
check("segredo do pagou não abre o appmax", rCruzado.status === 404, `status ${rCruzado.status}`);

const [{ count: nVendas }] = await sql`
  SELECT count(*)::int FROM orders WHERE tenant_id = ${seed.tenantId}`;
check("tres vendas, uma por gateway", nVendas === 3, String(nVendas));

console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " FALHA(S)") + "\n");
process.exit(falhas === 0 ? 0 : 1);
