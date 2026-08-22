/*
 * Teste dos três gateways.
 *
 * O que precisa ser provado aqui é diferente do teste ponta a ponta: não é se
 * o circuito funciona, é se cada dialeto de gateway chega ao mesmo formato
 * canônico — e se as diferenças entre eles aparecem onde deveriam aparecer.
 */
import { neon } from "@neondatabase/serverless";
import { webcrypto as wc, createHmac } from "node:crypto";

process.loadEnvFile(".env");
const sql = neon(process.env.DATABASE_URL);
const BASE = "http://localhost:3000";
const seed = JSON.parse(process.argv[2]);

let falhas = 0;
const check = (label, ok, extra = "") => {
  if (!ok) falhas++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${label}${extra ? "  → " + extra : ""}`);
};

/* Prepara uma sessão de clique e devolve o clickId. */
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

const enviar = (gw, corpo, headers = {}) =>
  fetch(`${BASE}/api/webhook/${gw}/${seed.gateways[gw].webhookSecret}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: corpo,
  });

/* ==================================================== APPMAX ============= */
console.log("\nAPPMAX — o gateway com endereço, que rende mais chaves");

const clickAppmax = await novaSessao();
const pedidoAppmax = 700000 + Math.floor(Math.random() * 99999);

const corpoAppmax = JSON.stringify({
  event: "order_approved",
  event_type: "order",
  data: {
    order: {
      id: pedidoAppmax,
      status: "aprovado",
      total_paid: 25990,
      amounts: { sub_total: 23990, shipping_value: 2000, discount: 0 },
      created_at: "2026-08-22 14:30:00",
      /* A loja carimba o clickId no tracking ao criar o pedido. */
      tracking: { sck: clickAppmax, utm_source: "facebook" },
      bundles: [{
        products: [
          { sku: "KIT-01", name: "Kit Completo", quantity: 2, price: 11995 },
        ],
      }],
    },
    customer: {
      firstname: "Maria",
      lastname: "Conceição",
      email: "MARIA.conceicao@Hotmail.com",
      telephone: "(21) 98888-7777",
      document_number: "123.456.789-09",
      postcode: "22040-002",
      city: "Rio de Janeiro",
      state: "RJ",
    },
    payment: { method: "creditcard", installments: 3, paid_at: "2026-08-22 14:31:00" },
  },
});

const rA = await enviar("appmax", corpoAppmax);
const jA = await rA.json();
check("webhook aceito", rA.status === 200, `status ${rA.status}`);
check("atribuído pelo clickId", jA.atribuicao === "click_id", jA.atribuicao);

const [vA] = await sql`SELECT * FROM orders WHERE gateway_order_id = ${String(pedidoAppmax)}`;
check("venda gravada e paga", vA?.status === "paid", vA?.status);
check("valor total com frete", Number(vA?.gross_cents) === 25990, String(vA?.gross_cents));
check("frete separado", Number(vA?.shipping_cents) === 2000, String(vA?.shipping_cents));
check("parcelas registradas", vA?.installments === 3, String(vA?.installments));

const itensA = await sql`SELECT * FROM order_items WHERE order_id = ${vA?.id}`;
check("item extraído de dentro do bundle", itensA[0]?.sku === "KIT-01", itensA[0]?.sku);
check("quantidade correta", itensA[0]?.quantity === 2, String(itensA[0]?.quantity));

const [dA] = await sql`SELECT * FROM dispatches WHERE order_id = ${vA?.id}`;
const chavesA = dA?.match_keys ?? [];
console.log("     chaves: " + chavesA.join(", "));
check("treze chaves de correspondência", chavesA.length === 13, String(chavesA.length));
for (const k of ["ct", "st", "zp", "country"]) {
  check(`  chave ${k} (só a Appmax entrega)`, chavesA.includes(k));
}

const udA = dA?.request_body?.data?.[0]?.user_data;
check("dois external_id (sessão + CPF)", udA?.external_id?.length === 2, String(udA?.external_id?.length));

const hash = async (v) => Buffer.from(
  await wc.subtle.digest("SHA-256", new TextEncoder().encode(v)),
).toString("hex");

check("CPF sem pontuação antes do hash", udA?.external_id?.includes(await hash("12345678909")));
check("sobrenome sem acento", udA?.ln?.[0] === await hash("conceicao"));
check("CEP só com dígitos", udA?.zp?.[0] === await hash("22040002"));
check("UF em duas letras minúsculas", udA?.st?.[0] === await hash("rj"));
check("cidade sem espaço nem acento", udA?.ct?.[0] === await hash("riodejaneiro"));

/* ================================================== MILLIONS ============ */
console.log("\nMILLIONS — o primeiro gateway com assinatura de verdade");

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
    /* O clickId viaja no metadata, que a Millions devolve intacto. */
    metadata: { rr_click_id: clickMillions, order_id: "ABC-123" },
    captured_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  },
  occurred_at: new Date().toISOString(),
});

const assinar = (corpo, segredo) =>
  "sha256=" + createHmac("sha256", segredo).update(corpo).digest("hex");

const assinatura = assinar(corpoMillions, seed.gateways.millions.webhookSecret);

const rM = await enviar("millions", corpoMillions, { "x-soarlabz-signature": assinatura });
const jM = await rM.json();
check("webhook com assinatura válida aceito", rM.status === 200, `status ${rM.status}`);
check("marcado como VERIFICADO", jM.verificado === true);
check("clickId encontrado no metadata", jM.atribuicao === "click_id", jM.atribuicao);

const [vM] = await sql`SELECT * FROM orders WHERE gateway_order_id = ${cobranca}`;
check("venda gravada e paga", vM?.status === "paid", vM?.status);
check("valor em centavos", Number(vM?.gross_cents) === 14900, String(vM?.gross_cents));
check("método pix", vM?.payment_method === "pix", vM?.payment_method);

const [dM] = await sql`SELECT * FROM dispatches WHERE order_id = ${vM?.id}`;
const chavesM = dM?.match_keys ?? [];
console.log("     chaves: " + chavesM.join(", "));
check("dez chaves (sem endereço, com CPF)", chavesM.length === 10, String(chavesM.length));
check("sem chave de CEP", !chavesM.includes("zp"));

const udM = dM?.request_body?.data?.[0]?.user_data;
check("CPF entrou como external_id", udM?.external_id?.includes(await hash("98765432100")));

console.log("\n  defesas da assinatura");

/* Assinatura de outro segredo não passa. */
const rBad = await enviar("millions", corpoMillions, {
  "x-soarlabz-signature": assinar(corpoMillions, "segredo-do-atacante"),
});
check("assinatura de segredo errado rejeitada", rBad.status === 401, `status ${rBad.status}`);

/*
 * Corpo adulterado invalida a assinatura original — o cenário que a assinatura
 * existe para impedir: alguém intercepta a venda e troca o valor.
 * Sem espaço depois dos dois-pontos: é assim que JSON.stringify serializa.
 */
const adulterado = corpoMillions.replace('"total_amount":14900', '"total_amount":1');
if (adulterado === corpoMillions) throw new Error("o teste nao adulterou nada");
const rTamper = await enviar("millions", adulterado, { "x-soarlabz-signature": assinatura });
check("corpo adulterado rejeitado", rTamper.status === 401, `status ${rTamper.status}`);

/* Sem header nenhum também não passa. */
const rSem = await enviar("millions", corpoMillions);
check("sem assinatura rejeitada", rSem.status === 401, `status ${rSem.status}`);

/* ================================================= INDEPENDÊNCIA ======== */
console.log("\nISOLAMENTO — cada conexão só aceita o próprio segredo");

const rCruzado = await fetch(
  `${BASE}/api/webhook/appmax/${seed.gateways.pagou.webhookSecret}`,
  { method: "POST", headers: { "content-type": "application/json" }, body: corpoAppmax },
);
check("segredo do pagou não abre o appmax", rCruzado.status === 404, `status ${rCruzado.status}`);

const [{ count: nVendas }] = await sql`
  SELECT count(*)::int FROM orders WHERE tenant_id = ${seed.tenantId}`;
check("duas vendas no total, uma por gateway", nVendas === 2, String(nVendas));

console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " FALHA(S)") + "\n");
process.exit(falhas === 0 ? 0 : 1);
