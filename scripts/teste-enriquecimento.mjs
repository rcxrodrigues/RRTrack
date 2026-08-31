/*
 * O caminho do endereço, que nenhum gateway devolve.
 *
 * Resultado da pesquisa nas três documentações: o pagou.ai aceita CEP e CPF ao
 * cadastrar um cliente e não os devolve em consulta nenhuma; a Appmax não traz
 * comprador no webhook de pedido; a Millions não documenta a resposta. Ou seja,
 * as chaves ct, st, zp e db estariam perdidas para sempre.
 *
 * Só que quem tem esse dado primeiro é a LOJA — o checkout dela pediu o CEP
 * para calcular frete antes de o gateway entrar na história. Este teste prova
 * que ela consegue repassar, e que o disparo sai com o conjunto completo.
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

const hash = async (v) => Buffer.from(
  await wc.subtle.digest("SHA-256", new TextEncoder().encode(v)),
).toString("hex");

/* Formato da Appmax: "AAAA-MM-DD HH:MM:SS", horario de Brasilia. */
const horasAtras = (h) => new Date(Date.now() - h * 3600_000)
  .toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" });

const clickId = wc.randomUUID();
const pedido = 800000 + Math.floor(Math.random() * 99999);
const marca = Date.now();

/* ------------------------------------------------------- 1. o clique -- */
console.log("\n1. sessão de clique");

const r1 = await fetch(`${BASE}/rr/collect`, {
  method: "POST",
  headers: { "content-type": "text/plain", "user-agent": "Mozilla/5.0 (iPhone)" },
  body: JSON.stringify({
    site_key: seed.siteKey,
    click_id: clickId,
    external_id: wc.randomUUID(),
    event: "page_view",
    event_id: "pv." + marca,
    attribution: { utm_source: "FB", utm_campaign: "Enriquecimento|C900", fbclid: "IwARenriq" },
    fbp: "fb.1." + marca + ".7788990011",
    fbc: "fb.1." + marca + ".IwARenriq",
    page_url: "https://loja.exemplo.com.br/",
    occurred_at: new Date().toISOString(),
  }),
});
check("coletor aceitou", r1.status === 204, `status ${r1.status}`);

/* ------------------------------------ 2. a loja reivindica COM o CEP -- */
console.log("\n2. a loja reivindica o pedido e manda o que só ela sabe");

const rc = await fetch(`${BASE}/api/claim`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    site_key: seed.siteKey,
    click_id: clickId,
    gateway: "appmax",
    gateway_order_id: pedido,
    customer: {
      /* Sujo de propósito: acento, pontuação, formato brasileiro de data. */
      name: "José Antônio Nogueira",
      email: "  JOSE.nogueira@Gmail.COM ",
      phone: "(31) 98877-6655",
      document: "123.456.789-09",
      zip: "30140-071",
      city: "Belo Horizonte",
      state: "MG",
      birthdate: "14/03/1988",
      gender: "Masculino",
    },
  }),
});
const jc = await rc.json();
check("reivindicação aceita", rc.status === 200, `status ${rc.status}`);
check("comprador recebido", jc.comprador === 9, String(jc.comprador));

const [claim] = await sql`SELECT customer FROM order_claims WHERE gateway_order_id = ${String(pedido)}`;
check("comprador gravado", !!claim?.customer);
check("cifrado no banco", !JSON.stringify(claim.customer).includes("Gmail"));
check("cifrado: nem o CEP em claro", !JSON.stringify(claim.customer).includes("30140"));

/* --------------------------------------------- 3. a venda pelo webhook */
console.log("\n3. venda pela Appmax, que não manda comprador nenhum");

const corpo = JSON.stringify({
  event: "order_approved",
  event_type: "order",
  data: {
    order_id: pedido,
    status: "aprovado",
    total: 34900,
    freight_value: 0,
    /*
     * Datas RELATIVAS, e nao fixas.
     *
     * Estavam escritas como "2026-08-24 10:00:00", que funcionou no dia em que
     * este teste nasceu e apodreceu sozinha: a Meta recusa evento com mais de
     * sete dias, e nos barramos antes de enviar. Uma semana depois o disparo
     * passou a falhar com "fora da janela de 7 dias" e nove asseroes cairam
     * juntas, parecendo defeito de normalizacao.
     *
     * Duas horas atras e o que uma venda de verdade parece.
     */
    paid_at: horasAtras(2),
    created_at: horasAtras(2.05),
    products: [{ sku: "PROD-9", name: "Kit", price: 34900, quantity: 1 }],
    payment_info: { pix: { captured_at: "2026-08-24 10:00:00" } },
  },
});

const rw = await fetch(`${BASE}/api/webhook/appmax/${seed.gateways.appmax.webhookSecret}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: corpo,
});
const jw = await rw.json();
check("webhook aceito", rw.status === 200, `status ${rw.status}`);
check("atribuído pela reivindicação", jw.atribuicao === "order_claim", jw.atribuicao);

/* --------------------------------------------------- 4. o que saiu --- */
console.log("\n4. o disparo para a Meta");

const [venda] = await sql`SELECT * FROM orders WHERE gateway_order_id = ${String(pedido)}`;
check("venda gravada", !!venda);

/*
 * Espera o `request_body` aparecer, e nao so a linha do disparo.
 *
 * As chaves de correspondencia sao gravadas quando o disparo e montado; o
 * corpo da requisicao, quando ele e enviado. Sao duas escritas, e sob carga a
 * segunda demora — rodando a suite inteira, este teste lia a linha entre uma
 * e outra e as nove asseroes de normalizacao falhavam de uma vez.
 *
 * Isolado passava sempre, junto falhava: teste que depende de quem rodou antes
 * e ruido, e ruido faz a suite deixar de ser levada a serio.
 */
let d;
for (let tentativa = 0; tentativa < 20; tentativa++) {
  [d] = await sql`SELECT * FROM dispatches WHERE order_id = ${venda?.id}`;
  if (d?.request_body) break;
  await new Promise((r) => setTimeout(r, 500));
}
const chaves = (d?.match_keys ?? []).sort();
console.log("     chaves: " + chaves.join(", "));

/*
 * Sem o repasse da loja, a Appmax rende 5 chaves — só as de navegador.
 * Com ele, chega ao conjunto completo que a Meta reconhece.
 */
check("quinze chaves de correspondência", chaves.length === 15, String(chaves.length));

for (const k of ["em", "ph", "fn", "ln", "ct", "st", "zp", "country", "db", "ge",
                 "external_id", "fbp", "fbc", "ip", "user_agent"]) {
  check(`  ${k}`, chaves.includes(k));
}

console.log("\n5. normalização antes do hash");

const ud = d?.request_body?.data?.[0]?.user_data;
check("e-mail em minúscula e sem espaço", ud?.em?.[0] === await hash("jose.nogueira@gmail.com"),
  ud ? `campos: ${Object.keys(ud).sort().join(",")}` : `SEM request_body (status ${d?.status}, erro ${String(d?.error).slice(0,60)})`);
check("telefone com DDI", ud?.ph?.[0] === await hash("5531988776655"));
check("sobrenome sem acento", ud?.ln?.[0] === await hash("nogueira"));
check("CEP só com dígitos", ud?.zp?.[0] === await hash("30140071"));
check("cidade sem espaço nem acento", ud?.ct?.[0] === await hash("belohorizonte"));
check("UF em duas letras", ud?.st?.[0] === await hash("mg"));
check("data BR virou AAAAMMDD", ud?.db?.[0] === await hash("19880314"));
check("gênero virou uma letra", ud?.ge?.[0] === await hash("m"));
check("CPF entre os external_id", ud?.external_id?.includes(await hash("12345678909")));
/*
 * Antes isto varria o JSON inteiro atras das substrings "gmail", "30140" e
 * "Nogueira". A do CEP falhava sozinha, de vez em quando: "30140" so tem
 * digitos hexadecimais, e o `external_id` carrega o hash do click_id, que
 * muda a cada execucao. Uma vez a cada poucos milhares de rodadas um hash
 * contem essa sequencia por acaso e o teste acusava vazamento inexistente.
 *
 * Teste que falha sozinho e pior que teste ausente: ensina a ignorar a suite,
 * e o dia em que o vazamento for de verdade ninguem vai olhar.
 *
 * A verificacao agora e mais forte e nao depende de sorte: todo campo de PII
 * tem que ser exatamente 64 digitos hexadecimais, o formato de um SHA-256.
 * Qualquer coisa em claro falha nisso — nao so as tres palavras que alguem
 * lembrou de procurar. Os campos que a Meta espera SEM hash (ip, user agent,
 * fbp, fbc) ficam de fora da regra, que e o motivo de a lista ser explicita.
 */
const HASH = /^[0-9a-f]{64}$/;
const PII = ["em", "ph", "fn", "ln", "zp", "ct", "st", "country", "db", "ge", "external_id"];
const emClaro = PII.flatMap((c) => (ud?.[c] ?? []).map((v) => [c, v]))
  .filter(([, v]) => !HASH.test(String(v)));
check("todo campo de PII e um SHA-256, nada em claro", emClaro.length === 0,
  emClaro.map(([c, v]) => `${c}=${v}`).join(" "));

console.log("\n6. a estrutura do anúncio veio junto");
const [s] = await sql`SELECT campaign_id, campaign_name FROM click_sessions WHERE click_id = ${clickId}`;
check("id da campanha lido da UTM", s?.campaign_id === "C900", s?.campaign_id);
check("nome da campanha", s?.campaign_name === "Enriquecimento", s?.campaign_name);

console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " FALHA(S)") + "\n");
process.exit(falhas === 0 ? 0 : 1);
