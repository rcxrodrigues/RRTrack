/*
 * Google Ads — conversão por clique e leitura de gasto, com a API simulada.
 *
 * O Google é o mais diferente dos três, e o que prova isso são quatro coisas
 * que não existem nas outras plataformas:
 *
 *   dinheiro em MICROS (R$ 1,50 chega como 1500000)
 *   e-mail do Gmail perdendo pontos e sufixo antes do hash
 *   userIdentifiers como lista de objetos com UM campo cada (oneof)
 *   recusa chegando dentro de um HTTP 200, em partialFailureError
 *
 * Compilar antes:
 *   npx tsc src/destinations/google.ts src/ads/google.ts --outDir _tmp \
 *     --target ES2022 --module commonjs --moduleResolution node \
 *     --skipLibCheck --esModuleInterop --strict
 *   echo {"type":"commonjs"} > _tmp/package.json
 *   node scripts/teste-google.cjs
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
let respostaConversao = null;
let respostaRelatorio = null;

globalThis.fetch = async (url, init) => {
  ultimaUrl = String(url);
  if (String(url).includes("oauth2.googleapis.com")) {
    return { ok: true, json: async () => ({ access_token: "at_1", expires_in: 3600 }) };
  }
  if (init?.body) ultimoCorpo = JSON.parse(init.body);
  if (String(url).includes("uploadClickConversions")) return respostaConversao;
  return respostaRelatorio;
};

const { googleAdapter } = require("../_tmp/destinations/google.js");
const { googleAdsAdapter } = require("../_tmp/ads/google.js");

const CRED = {
  developerToken: "dev", clientId: "ci", clientSecret: "cs",
  refreshToken: "rt", conversionAction: "customers/1/conversionActions/9",
};

const venda = (extra = {}) => ({
  event: "purchase",
  eventId: "trx_1",
  occurredAt: new Date("2026-08-24T18:30:00Z"),
  order: {
    gatewayOrderId: "PED-77", status: "paid", currency: "BRL", grossCents: 15000,
    gatewayEventId: "e", paymentMethod: "pix", passthrough: {}, raw: {},
    occurredAt: new Date(),
    items: [],
    customer: {
      name: "José Antônio Nogueira",
      email: "Jo.Se+loja@Gmail.com",
      phone: "(31) 98877-6655",
      city: "Belo Horizonte", state: "MG", zip: "30140-071", country: "br",
    },
  },
  click: { clickId: "s1", gclid: "GCL_ABC", ip: "1.2.3.4", userAgent: "UA" },
  valueCents: 15000, currency: "BRL",
  ...extra,
});

(async () => {

  console.log("\n== conversão entregue ==");
  respostaConversao = { ok: true, status: 200, json: async () => ({ results: [{}] }) };
  const r = await googleAdapter.send(venda(), { externalId: "123-456-7890", credentials: CRED });

  eq("entregue", r.ok, true);
  eq("id da conta sem hífen na URL", ultimaUrl.includes("customers/1234567890:"), true);

  const c = ultimoCorpo.conversions[0];
  eq("gclid enviado", c.gclid, "GCL_ABC");
  eq("ação de conversão", c.conversionAction, "customers/1/conversionActions/9");
  eq("valor em reais", c.conversionValue, 150);
  eq("id do pedido para dedupe", c.orderId, "PED-77");
  eq("falha parcial ligada", ultimoCorpo.partialFailure, true);

  console.log("\n== a data leva fuso explícito ==");
  eq("formato com deslocamento", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}-03:00$/.test(c.conversionDateTime), true);
  eq("convertido para Brasília", c.conversionDateTime.startsWith("2026-08-24 15:30:00"), true);

  console.log("\n== e-mail do Gmail perde ponto e sufixo ==");
  const email = c.userIdentifiers.find((u) => u.hashedEmail);
  eq("jo.se+loja@gmail.com vira jose@gmail.com", email.hashedEmail, await hash("jose@gmail.com"));
  eq("e NÃO o formato da Meta", email.hashedEmail !== await hash("jo.se+loja@gmail.com"), true);

  console.log("\n== um campo por identificador (oneof) ==");
  eq("e-mail sozinho no objeto dele", Object.keys(email).length, 1);
  const tel = c.userIdentifiers.find((u) => u.hashedPhoneNumber);
  eq("telefone em objeto próprio", Object.keys(tel).length, 1);
  eq("telefone COM o sinal de mais", tel.hashedPhoneNumber, await hash("+5531988776655"));

  console.log("\n== endereço: nome hasheado, resto em claro ==");
  const end = c.userIdentifiers.find((u) => u.addressInfo).addressInfo;
  eq("nome hasheado", end.hashedFirstName, await hash("jose"));
  eq("sobrenome hasheado", end.hashedLastName, await hash("nogueira"));
  eq("cidade EM CLARO", end.city, "belohorizonte");
  eq("estado em claro", end.state, "mg");
  eq("CEP em claro", end.postalCode, "30140071");
  eq("país em maiúscula", end.countryCode, "BR");
  eq("três identificadores", c.userIdentifiers.length, 3);

  console.log("\n== sem gclid não sai ==");
  let chamou = false;
  const antes = globalThis.fetch;
  globalThis.fetch = async (u, i) => { if (!String(u).includes("oauth2")) chamou = true; return antes(u, i); };
  const semClique = await googleAdapter.send(
    venda({ click: { clickId: "s1" } }),
    { externalId: "123", credentials: CRED },
  );
  globalThis.fetch = antes;
  eq("recusado antes de chamar", semClique.ok, false);
  eq("motivo explícito", semClique.error.includes("sem gclid"), true);
  eq("não gastou chamada", chamou, false);

  console.log("\n== recusa dentro de HTTP 200 ==");
  respostaConversao = {
    ok: true, status: 200,
    json: async () => ({ partialFailureError: { message: "ConversionUploadError.INVALID_CONVERSION_ACTION" } }),
  };
  const rRec = await googleAdapter.send(venda(), { externalId: "123", credentials: CRED });
  eq("NÃO conta como entregue", rRec.ok, false);
  eq("mensagem preservada", rRec.error.includes("INVALID_CONVERSION_ACTION"), true);

  console.log("\n== não aceita evento de navegação ==");
  eq("purchase sim", googleAdapter.supports.includes("purchase"), true);
  eq("view_content não", googleAdapter.supports.includes("view_content"), false);

  console.log("\n== gasto: micros viram centavos ==");
  respostaRelatorio = {
    ok: true,
    json: async () => ({
      results: [
        {
          segments: { date: "2026-08-24" },
          campaign: { id: "C1", name: "Marca" },
          adGroup: { id: "G1", name: "Termos" },
          adGroupAd: { ad: { id: "A1", name: "Texto principal" } },
          metrics: { costMicros: "1500000", impressions: "900", clicks: "40", conversions: 3, conversionsValue: 450.5 },
        },
        {
          segments: { date: "2026-08-24" },
          campaign: { id: "C1" },
          adGroup: { id: "G1" },
          adGroupAd: { ad: { id: "A2" } },
          metrics: { costMicros: "12345", impressions: "10" },
        },
      ],
    }),
  };

  const g = await googleAdsAdapter.buscarGasto("123-456-7890", { ...CRED, moeda: "BRL" }, { de: "2026-08-24", ate: "2026-08-24" });
  const a1 = g.linhas.find((l) => l.adId === "A1");
  /* Micro é milionésimo: 1.500.000 micros = 1,5 unidade = R$ 1,50 = 150 centavos. */
  eq("1.500.000 micros viram 150 centavos", a1.gastoCents, 150);
  eq("e NÃO 1.500.000 tratado como centavos", a1.gastoCents !== 1500000, true);
  eq("grupo de anúncios vira conjunto", a1.adsetName, "Termos");
  eq("conversões da plataforma", a1.conversoesPlataforma, 3);
  eq("faturamento da plataforma em centavos", a1.faturamentoPlataformaCents, 45050);

  const a2 = g.linhas.find((l) => l.adId === "A2");
  eq("micros pequenos arredondam", a2.gastoCents, 1);
  eq("anúncio sem nome cai no id", a2.adName, "A2");

  console.log("\n== erros que o lojista resolve têm nome ==");
  respostaRelatorio = { ok: false, status: 403, text: async () => "DEVELOPER_TOKEN_NOT_APPROVED", json: async () => ({}) };
  try {
    await googleAdsAdapter.buscarGasto("123", CRED, { de: "2026-08-24", ate: "2026-08-24" });
    eq("deveria lançar", false, true);
  } catch (e) {
    eq("diz que falta aprovação", e.message.includes("não aprovado"), true);
  }

  console.log("\n== sem developer token nem tenta ==");
  try {
    await googleAdsAdapter.buscarGasto("123", { clientId: "a", clientSecret: "b", refreshToken: "c" }, { de: "2026-08-24", ate: "2026-08-24" });
    eq("deveria lançar", false, true);
  } catch (e) {
    eq("erro claro", e.message.includes("developer token"), true);
  }

  console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
  process.exit(f === 0 ? 0 : 1);
})();
