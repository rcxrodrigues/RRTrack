/*
 * TikTok — envio de conversão e leitura de gasto, com a API simulada.
 *
 * O que precisa ficar provado são as três diferenças que fazem o evento chegar
 * e não casar com ninguém, se tratadas como se fosse a Meta:
 *
 *   telefone COM o sinal de mais (a Meta quer sem)
 *   erro chegando com HTTP 200 e `code` diferente de zero
 *   dimensão e métrica em objetos separados no relatório
 *
 * Compilar antes:
 *   npx tsc src/destinations/tiktok.ts src/ads/tiktok.ts --outDir _tmp \
 *     --target ES2022 --module commonjs --moduleResolution node \
 *     --skipLibCheck --esModuleInterop --strict
 *   echo {"type":"commonjs"} > _tmp/package.json
 *   node scripts/teste-tiktok.cjs
 */
const { webcrypto: wc } = require("node:crypto");

let f = 0;
const eq = (l, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  if (!ok) f++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${l}` + (ok ? "" : `  obtido ${JSON.stringify(g)}, esperado ${JSON.stringify(w)}`));
};

const hash = async (v) => Buffer.from(
  await wc.subtle.digest("SHA-256", new TextEncoder().encode(v)),
).toString("hex");

let ultimoCorpo = null;
let ultimaUrl = null;
let resposta = null;

globalThis.fetch = async (url, init) => {
  ultimaUrl = String(url);
  if (init?.body) ultimoCorpo = JSON.parse(init.body);
  return resposta;
};

const { tiktokAdapter } = require("../_tmp/destinations/tiktok.js");
const { tiktokAdsAdapter } = require("../_tmp/ads/tiktok.js");

(async () => {

  console.log("\n== conversão: o payload ==");
  resposta = { ok: true, status: 200, json: async () => ({ code: 0, message: "OK" }) };

  const r = await tiktokAdapter.send({
    event: "purchase",
    eventId: "trx_1",
    occurredAt: new Date("2026-08-24T13:00:00Z"),
    order: {
      gatewayOrderId: "trx_1",
      status: "paid", currency: "BRL", grossCents: 8990,
      gatewayEventId: "e1", paymentMethod: "pix", passthrough: {}, raw: {},
      occurredAt: new Date(),
      items: [{ sku: "1313", name: "Carimbo", quantity: 1, unitPriceCents: 8990 }],
      customer: {
        name: "José Antônio Nogueira",
        email: "  JOSE.nogueira@Gmail.COM ",
        phone: "(31) 98877-6655",
        document: "123.456.789-09",
        zip: "30140-071", city: "Belo Horizonte", state: "MG", country: "br",
      },
    },
    click: { clickId: "abc-123", ttclid: "TTCL123", ip: "1.2.3.4", userAgent: "UA" },
    sourceUrl: "https://loja.exemplo.com.br/obrigado",
    valueCents: 8990,
    currency: "BRL",
  }, { externalId: "PIXEL9", credentials: { accessToken: "tok" }, testEventCode: "TT_TESTE" });

  eq("entregue", r.ok, true);
  eq("endpoint v1.3", ultimaUrl.includes("/open_api/v1.3/event/track/"), true);

  const ev = ultimoCorpo.data[0];
  eq("event_source web", ultimoCorpo.event_source, "web");
  eq("pixel no event_source_id", ultimoCorpo.event_source_id, "PIXEL9");
  eq("código de teste enviado", ultimoCorpo.test_event_code, "TT_TESTE");
  eq("nome do evento", ev.event, "CompletePayment");
  eq("event_time em SEGUNDOS", ev.event_time, 1787576400);
  eq("event_id igual ao da Meta (dedupe)", ev.event_id, "trx_1");

  console.log("\n== a diferença que mata: telefone com + ==");
  eq("telefone COM o sinal de mais", ev.user.phone, await hash("+5531988776655"));
  eq("e NÃO no formato da Meta", ev.user.phone !== await hash("5531988776655"), true);

  console.log("\n== demais chaves ==");
  eq("e-mail normalizado", ev.user.email, await hash("jose.nogueira@gmail.com"));
  eq("nome sem acento", ev.user.first_name, await hash("jose"));
  eq("sobrenome", ev.user.last_name, await hash("nogueira"));
  eq("cidade", ev.user.city, await hash("belohorizonte"));
  eq("estado", ev.user.state, await hash("mg"));
  eq("CEP só dígitos", ev.user.zip_code, await hash("30140071"));
  eq("país", ev.user.country, await hash("br"));
  eq("external_id da sessão, hasheado", ev.user.external_id, await hash("abc-123"));
  eq("ttclid em claro", ev.user.ttclid, "TTCL123");
  eq("ip em claro", ev.user.ip, "1.2.3.4");
  eq("doze chaves", r.matchKeys.length, 12);
  eq("nada pessoal em claro", !JSON.stringify(ev.user).includes("gmail")
    && !JSON.stringify(ev.user).includes("30140"), true);

  console.log("\n== propriedades ==");
  eq("valor em reais", ev.properties.value, 89.9);
  eq("moeda", ev.properties.currency, "BRL");
  eq("SKU no contents", ev.properties.contents[0].content_id, "1313");
  eq("id do pedido", ev.properties.order_id, "trx_1");

  console.log("\n== erro com HTTP 200 ==");
  resposta = { ok: true, status: 200, json: async () => ({ code: 40002, message: "Invalid pixel code" }) };
  const rErro = await tiktokAdapter.send(
    { event: "purchase", eventId: "x", occurredAt: new Date(), click: {} },
    { externalId: "P", credentials: { accessToken: "t" } },
  );
  eq("NÃO trata como sucesso", rErro.ok, false);
  eq("mensagem do TikTok preservada", rErro.error.includes("Invalid pixel code"), true);
  eq("erro de payload não é para repetir", rErro.retryable, false);

  console.log("\n== limite de chamadas é para repetir ==");
  resposta = { ok: true, status: 200, json: async () => ({ code: 40100, message: "Too many requests" }) };
  const rLim = await tiktokAdapter.send(
    { event: "purchase", eventId: "x", occurredAt: new Date(), click: {} },
    { externalId: "P", credentials: { accessToken: "t" } },
  );
  eq("marcado como repetível", rLim.retryable, true);

  console.log("\n== gasto: dimensão e métrica separadas ==");
  let pagina = 0;
  globalThis.fetch = async (url) => {
    ultimaUrl = String(url);
    pagina++;
    return {
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          list: pagina === 1 ? [
            {
              dimensions: { ad_id: "AD1", stat_time_day: "2026-08-24 00:00:00" },
              metrics: {
                spend: "123.45", impressions: "5000", clicks: "80",
                campaign_id: "C1", campaign_name: "Frio",
                adgroup_id: "G1", adgroup_name: "Amplo",
                ad_name: "UGC 12", complete_payment: "7",
              },
            },
          ] : [
            {
              dimensions: { ad_id: "AD2", stat_time_day: "2026-08-24 00:00:00" },
              metrics: { spend: "10.00", ad_name: "UGC 09" },
            },
          ],
          page_info: { total_page: 2 },
        },
      }),
    };
  };

  const g = await tiktokAdsAdapter.buscarGasto("7123456789", { accessToken: "t" }, { de: "2026-08-24", ate: "2026-08-24" });
  eq("nível de anúncio", ultimaUrl.includes("AUCTION_AD"), true);
  eq("paginou até o fim", g.linhas.length, 2);

  const a1 = g.linhas.find((l) => l.adId === "AD1");
  eq("gasto de string para centavos", a1.gastoCents, 12345);
  eq("data sem a hora", a1.data, "2026-08-24");
  eq("campanha veio das MÉTRICAS", a1.campaignName, "Frio");
  eq("conjunto é o adgroup", a1.adsetId, "G1");
  eq("conversões da plataforma", a1.conversoesPlataforma, 7);

  console.log("\n== gasto: erro com HTTP 200 ==");
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ code: 40105, message: "Access token invalid" }) });
  try {
    await tiktokAdsAdapter.buscarGasto("7123", { accessToken: "t" }, { de: "2026-08-24", ate: "2026-08-24" });
    eq("deveria ter lançado", false, true);
  } catch (e) {
    eq("token inválido vira erro, não conta vazia", e.message.includes("40105"), true);
  }

  console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
  process.exit(f === 0 ? 0 : 1);
})();
