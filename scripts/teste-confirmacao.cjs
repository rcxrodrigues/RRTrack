/*
 * A confirmação pela API, em gateway que não assina o webhook.
 *
 * O que precisa ficar provado é a distinção que rege a decisão do roteador:
 * 404 devolve null (o pedido não existe, é fraude), e 503 LANÇA (a API está
 * fora, não se sabe). Trocar os dois faria o sistema ou aceitar venda forjada
 * ou recusar venda real por instabilidade alheia.
 *
 * Compilar antes:
 *   npx tsc src/gateways/pagou.ts src/gateways/appmax.ts --outDir _tmp  *     --target ES2022 --module commonjs --moduleResolution node  *     --skipLibCheck --esModuleInterop
 *   echo {"type":"commonjs"} > _tmp/package.json
 *   node scripts/teste-confirmacao.cjs
 */
let f = 0;
const eq = (l, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) f++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${l}` + (ok ? "" : `  obtido ${JSON.stringify(g)}, esperado ${JSON.stringify(w)}`)); };

let resposta;
globalThis.fetch = async () => resposta;

const { pagouAdapter } = require("../_tmp/gateways/pagou.js");
const { appmaxAdapter } = require("../_tmp/gateways/appmax.js");

(async () => {

console.log("\n== pagou.ai: pedido existe ==");
resposta = { ok: true, status: 200, json: async () => ({
  data: { id: "trx_1", status: "paid", amount: 8970, currency: "BRL",
    payment_method: "pix",
    customer: { name: "Ana", email: "ana@x.com", phone: "11999998888" },
    products: [{ external_id: "1313", name: "Carimbo", quantity: 1, unit_price: 8970 }] },
}) };
const p1 = await pagouAdapter.fetchOrder("trx_1", { apiKey: "k" });
eq("devolve o pedido", p1 !== null, true);
eq("valor da API", p1.grossCents, 8970);
eq("status mapeado", p1.status, "paid");
eq("comprador veio junto", p1.customer.email, "ana@x.com");
eq("item lido", p1.items[0].sku, "1313");

console.log("\n== pagou.ai: pedido NÃO existe ==");
resposta = { ok: false, status: 404, json: async () => ({}) };
eq("404 devolve null, não erro", await pagouAdapter.fetchOrder("forjado", { apiKey: "k" }), null);

console.log("\n== pagou.ai: API instável ==");
resposta = { ok: false, status: 503, text: async () => "", json: async () => ({}) };
try {
  await pagouAdapter.fetchOrder("trx_1", { apiKey: "k" });
  eq("deveria lançar em 503", false, true);
} catch (e) {
  eq("lança, para o roteador NÃO recusar a venda", e.message.includes("503"), true);
}

console.log("\n== pagou.ai: sem credencial nem tenta ==");
eq("sem chave devolve null", await pagouAdapter.fetchOrder("trx_1", {}), null);

console.log("\n== appmax ==");
let chamadas = 0;
globalThis.fetch = async (url) => {
  chamadas++;
  if (String(url).includes("oauth2/token")) {
    return { ok: true, json: async () => ({ access_token: "tk" }) };
  }
  return { ok: true, status: 200, json: async () => ({
    data: { id: 3531, status: "aprovado", total_paid: 25990,
      customer: { name: "Maria", email: "m@x.com", document_number: "12345678909" },
      products: [{ sku: "P1", name: "Kit", quantity: 1, price: 25990 }] },
  }) };
};
const a1 = await appmaxAdapter.fetchOrder("3531", { clientId: "i", clientSecret: "s" });
eq("autenticou antes de consultar", chamadas, 2);
eq("valor", a1.grossCents, 25990);
eq("status português mapeado", a1.status, "paid");
eq("CPF recuperado", a1.customer.document, "12345678909");

console.log("\n== appmax: sem credencial ==");
eq("sem client_id devolve null", await appmaxAdapter.fetchOrder("1", {}), null);

console.log("\n== appmax: pedido inexistente ==");
globalThis.fetch = async (url) => {
  if (String(url).includes("oauth2/token")) return { ok: true, json: async () => ({ access_token: "tk" }) };
  return { ok: false, status: 404, json: async () => ({}) };
};
eq("404 devolve null", await appmaxAdapter.fetchOrder("999", { clientId: "i", clientSecret: "s" }), null);

console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
process.exit(f === 0 ? 0 : 1);
})();
