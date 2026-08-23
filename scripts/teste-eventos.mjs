/*
 * Prova que o meio do funil chega nas plataformas.
 *
 * Até aqui só a compra era disparada, porque o disparo nascia do webhook. Este
 * teste cobre o outro caminho: o evento sai do navegador, passa pelo coletor e
 * vira uma chamada para a Meta — com as chaves que o navegador tem.
 */
import { neon } from "@neondatabase/serverless";
import { webcrypto as wc } from "node:crypto";

process.loadEnvFile(".env");
const sql = neon(process.env.DATABASE_URL);
const BASE = process.env.RR_BASE || "http://localhost:3000";
const seed = JSON.parse(process.argv[2]);

let falhas = 0;
const check = (l, ok, e = "") => {
  if (!ok) falhas++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${l}${e ? "  → " + e : ""}`);
};

const clickId = wc.randomUUID();
const marca = Date.now();

async function beacon(evento, params, eventId) {
  const r = await fetch(`${BASE}/rr/collect`, {
    method: "POST",
    headers: { "content-type": "text/plain", "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)" },
    body: JSON.stringify({
      site_key: seed.siteKey,
      click_id: clickId,
      external_id: wc.randomUUID(),
      event: evento,
      event_id: eventId,
      attribution: { utm_source: "facebook", utm_campaign: "funil", fbclid: "IwARfunil" },
      fbp: "fb.1." + marca + ".1122334455",
      fbc: "fb.1." + marca + ".IwARfunil",
      page_url: "https://loja.exemplo.com.br/produto/carimbo",
      params: params || {},
      occurred_at: new Date().toISOString(),
    }),
  });
  return r.status;
}

/* O disparo roda depois da resposta; damos tempo de ele terminar. */
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("\n1. eventos do navegador saem do site");

const idView = "vc." + marca;
check("view_content aceito", await beacon("view_item", {
  currency: "BRL", value: 89.9,
  items: [{ item_id: "1313", item_name: "Carimbo de Delineador", price: 89.9, quantity: 1 }],
}, idView) === 204);

const idCart = "atc." + marca;
check("add_to_cart aceito", await beacon("add_to_cart", {
  currency: "BRL", value: 179.8,
  items: [{ item_id: "1313", price: 89.9, quantity: 2 }],
}, idCart) === 204);

const idCheckout = "ic." + marca;
check("begin_checkout aceito", await beacon("begin_checkout", {
  currency: "BRL", value: 179.8,
  items: [{ item_id: "1313", price: 89.9, quantity: 2 }],
}, idCheckout) === 204);

const idPage = "pv." + marca;
check("page_view aceito", await beacon("page_view", {}, idPage) === 204);

await esperar(6000);

console.log("\n2. viraram disparo para a Meta");

const [dView] = await sql`SELECT * FROM dispatches WHERE event_id = ${idView}`;
check("view_content disparado", !!dView, dView?.event_name);
check("mapeado de view_item", dView?.event_name === "view_content", dView?.event_name);

const [dCart] = await sql`SELECT * FROM dispatches WHERE event_id = ${idCart}`;
check("add_to_cart disparado", !!dCart);

const [dCheckout] = await sql`SELECT * FROM dispatches WHERE event_id = ${idCheckout}`;
check("begin_checkout disparado", !!dCheckout);
check("mapeado para initiate_checkout", dCheckout?.event_name === "initiate_checkout", dCheckout?.event_name);

/*
 * page_view fica fora do padrão de propósito: é o de maior volume e o de menor
 * valor de otimização. Quem quiser, liga na configuração do destino.
 */
const [dPage] = await sql`SELECT * FROM dispatches WHERE event_id = ${idPage}`;
check("page_view NÃO disparado (fora do padrão)", !dPage);

console.log("\n3. o que foi enviado");

const chaves = dView?.match_keys ?? [];
console.log("     chaves: " + chaves.join(", "));
check("cinco chaves de navegador", chaves.length === 5, String(chaves.length));
for (const k of ["external_id", "fbp", "fbc", "ip", "user_agent"]) {
  check(`  ${k}`, chaves.includes(k));
}
check("sem e-mail (ninguém se identificou ainda)", !chaves.includes("em"));

const ev = dView?.request_body?.data?.[0];
check("nome do evento na Meta", ev?.event_name === "ViewContent", ev?.event_name);
check("valor em reais", ev?.custom_data?.value === 89.9, String(ev?.custom_data?.value));
check("moeda", ev?.custom_data?.currency === "BRL", ev?.custom_data?.currency);
check("SKU no content_ids", JSON.stringify(ev?.custom_data?.content_ids) === '["1313"]', JSON.stringify(ev?.custom_data?.content_ids));
check("URL da página", ev?.event_source_url?.includes("/produto/carimbo"), ev?.event_source_url);
check("action_source website", ev?.action_source === "website", ev?.action_source);

const evCart = dCart?.request_body?.data?.[0];
check("quantidade no carrinho", evCart?.custom_data?.num_items === 2, String(evCart?.custom_data?.num_items));
check("valor do carrinho", evCart?.custom_data?.value === 179.8, String(evCart?.custom_data?.value));

console.log("\n4. o evento não é disparado duas vezes");

check("reenvio do mesmo beacon", await beacon("view_item", {
  currency: "BRL", value: 89.9,
  items: [{ item_id: "1313", price: 89.9, quantity: 1 }],
}, idView) === 204);
await esperar(4000);

const [{ count: n }] = await sql`SELECT count(*)::int FROM dispatches WHERE event_id = ${idView}`;
check("continua com um disparo só", n === 1, String(n));

console.log("\n5. a sessão de clique foi preservada");

const [s] = await sql`SELECT * FROM click_sessions WHERE click_id = ${clickId}`;
check("campanha guardada", s?.utm_campaign === "funil", s?.utm_campaign);
check("fbc montado do fbclid", s?.fbc?.endsWith("IwARfunil"), s?.fbc);

const [{ count: nEventos }] = await sql`SELECT count(*)::int FROM events WHERE click_id = ${clickId}`;
check("quatro eventos gravados", nEventos === 4, String(nEventos));

console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " FALHA(S)") + "\n");
process.exit(falhas === 0 ? 0 : 1);
