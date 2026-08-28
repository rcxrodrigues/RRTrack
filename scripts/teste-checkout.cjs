/*
 * O checkout próprio, com a Appmax simulada.
 *
 * A pergunta central é uma só: QUEM DECIDE O PREÇO. Um checkout que aceita o
 * valor enviado pelo navegador vende de graça na primeira vez que alguém abrir
 * o inspetor, e o painel não denuncia nada — a venda entra bonita, só que por
 * um real. Por isso o primeiro teste manda um corpo com preço, frete e itens
 * falsificados e confere o que de fato saiu para o gateway.
 *
 * A Appmax é substituída por um interceptador de `fetch`, e não por uma
 * biblioteca de simulação, porque assim o teste vê o corpo exato que o driver
 * montou. É a diferença entre provar que a função devolve o que prometeu e
 * provar que ela pede ao gateway o que devia — e foi a segunda que faltou nas
 * três vezes em que um adaptador deste projeto quebrou contra a realidade.
 *
 * Compilar antes:
 *   npx tsc src/checkout/index.ts src/checkout/appmax.ts src/checkout/gestao.ts \
 *     --outDir _tmp --target ES2022 --module commonjs --moduleResolution node \
 *     --skipLibCheck --esModuleInterop --strict
 *   echo {"type":"commonjs"} > _tmp/package.json
 *   node scripts/teste-checkout.cjs
 */
const { neon } = require("@neondatabase/serverless");
const { webcrypto: wc } = require("node:crypto");
process.loadEnvFile(".env");
const sql = neon(process.env.DATABASE_URL);

const { pagar, totalDoCheckout, checkoutPorSlug } = require("../_tmp/checkout/index.js");
const { normalizarSlug } = require("../_tmp/checkout/gestao.js");

let f = 0;
const ok = (l, c, e = "") => {
  if (!c) f++;
  console.log(`  ${c ? "ok  " : "FALHA"} | ${l}${e ? "  → " + e : ""}`);
};
const eq = (l, obtido, esperado) =>
  ok(l, JSON.stringify(obtido) === JSON.stringify(esperado),
    JSON.stringify(obtido) === JSON.stringify(esperado)
      ? "" : `obtido ${JSON.stringify(obtido)}, esperado ${JSON.stringify(esperado)}`);

/* ------------------------------------------------------ Appmax simulada -- */

const fetchReal = globalThis.fetch;

/* O que o driver mandou, na ordem. O teste lê daqui. */
let enviados = [];
/* O total que o GET /v1/orders/{id} vai alegar. null = espelha o pedido. */
let totalAlegado = null;
/* Força a cobrança a falhar com este status. */
let statusCobranca = 201;

const resposta = (corpo, status = 200) =>
  new Response(JSON.stringify(corpo), {
    status, headers: { "content-type": "application/json" },
  });

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  /* O banco também usa fetch; só a Appmax é desviada. */
  if (!u.includes("appmax.com.br")) return fetchReal(url, opts);

  const metodo = opts.method ?? "GET";
  let corpo;
  try { corpo = opts.body ? JSON.parse(opts.body) : undefined; } catch { corpo = String(opts.body); }
  enviados.push({ url: u, metodo, corpo });

  if (u.includes("/oauth2/token")) {
    return resposta({ access_token: "tok_" + Date.now(), expires_in: 3600 });
  }
  if (u.includes("/v1/customers")) {
    return resposta({ data: { customer: { id: 77 } } }, 201);
  }
  if (u.endsWith("/v1/orders")) {
    return resposta({ data: { order: { id: 999123, status: "pendente" } } }, 201);
  }
  if (/\/v1\/orders\/\d+$/.test(u)) {
    /* A conferência de total: por padrão confirma o que o pedido pediu. */
    const criado = enviados.find((e) => e.url.endsWith("/v1/orders") && e.metodo === "POST");
    const espelho = criado
      ? criado.corpo.products_value + criado.corpo.shipping_value - criado.corpo.discount_value
      : 0;
    return resposta({ data: { order: { total: totalAlegado ?? espelho } } });
  }
  if (u.includes("/v1/payments/pix")) {
    return resposta({
      data: {
        payment: {
          pix_qrcode: "iVBORw0KGgo=",
          pix_emv: "00020126BR.GOV.BCB.PIX",
          pix_expiration_date: "2026-08-25 23:59:00",
        },
      },
    }, 201);
  }
  if (u.includes("/v1/payments/credit-card")) {
    if (statusCobranca !== 201) {
      return resposta({ message: "Cartão recusado pelo emissor" }, statusCobranca);
    }
    return resposta({ data: { payment: { id: 5, status: "autorizado" } } }, 201);
  }
  return resposta({ message: "rota não simulada: " + u }, 404);
};

const limpar = () => { enviados = []; totalAlegado = null; statusCobranca = 201; };
const pedidoCriado = () => enviados.find((e) => e.url.endsWith("/v1/orders") && e.metodo === "POST");
const cobranca = () => enviados.find((e) => e.url.includes("/v1/payments/"));

/* --------------------------------------------------------------- cifra -- */

/* Mesmo formato de src/core/crypto.ts: AES-256-GCM, "iv.dados" em base64. */
async function cifrar(texto) {
  const bytes = Uint8Array.from(atob(process.env.CREDENTIALS_KEY), (c) => c.charCodeAt(0));
  const key = await wc.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt"]);
  const iv = wc.getRandomValues(new Uint8Array(12));
  const out = await wc.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(texto));
  const b64 = (b) => btoa(String.fromCharCode(...b));
  return `${b64(iv)}.${b64(new Uint8Array(out))}`;
}

/* CPF válido de verdade — o checkout confere o dígito antes de tocar na rede. */
const CPF_BOM = "111.444.777-35";

const compradorBase = {
  nome: "Maria da Silva Souza",
  email: "maria@exemplo.com",
  telefone: "(11) 98888-7777",
  documento: CPF_BOM,
  cep: "01310-100", rua: "Av. Paulista", numero: "1000",
  bairro: "Bela Vista", cidade: "São Paulo", estado: "SP",
};

(async () => {
  await sql`DELETE FROM tenants WHERE slug = 'checkout-teste'`;

  const [t] = await sql`INSERT INTO tenants (name, slug) VALUES ('Checkout', 'checkout-teste') RETURNING id`;
  const [site] = await sql`INSERT INTO sites (tenant_id, domain, public_key)
    VALUES (${t.id}, ${"ck-" + Date.now() + ".teste"}, ${"pk_ck_" + Date.now()}) RETURNING id, public_key`;

  const [conn] = await sql`INSERT INTO gateway_connections (tenant_id, gateway, label, webhook_secret, credentials)
    VALUES (${t.id}, 'appmax', 'Appmax teste', ${"ws_ck_" + Date.now()},
      ${JSON.stringify({
        clientId: await cifrar("cliente-123"),
        clientSecret: await cifrar("segredo-456"),
      })}::jsonb)
    RETURNING id`;

  /* A oferta verdadeira: R$ 149,90 + R$ 19,90 de frete = R$ 169,80. */
  const ITENS = [{ sku: "KIT-1", name: "Kit Verão", quantity: 1, unitPriceCents: 14990 }];
  const FRETE = 1990;

  const criarCheckout = async (slug, extra = {}) => {
    const [c] = await sql`INSERT INTO checkouts
      (tenant_id, slug, name, gateway_connection_id, site_id, items, shipping_cents,
       methods, max_installments, config)
      VALUES (${t.id}, ${slug}, ${"Oferta " + slug}, ${conn.id}, ${site.id},
        ${JSON.stringify(extra.items ?? ITENS)}::jsonb, ${extra.frete ?? FRETE},
        ${JSON.stringify(extra.methods ?? ["pix", "credit_card"])}::jsonb,
        ${extra.maxInstallments ?? 12},
        ${JSON.stringify(extra.config ?? {})}::jsonb)
      RETURNING id`;
    return c.id;
  };

  await criarCheckout("oferta-principal");

  /* ------------------------------------------------- 1. quem decide o preço */
  console.log("\nO PREÇO VEM DO BANCO, NUNCA DO NAVEGADOR");
  limpar();

  const golpe = await pagar({
    slug: "oferta-principal",
    metodo: "pix",
    comprador: compradorBase,
    /* Tudo abaixo é ruído: o servidor não deve olhar para nada disto. */
    items: [{ sku: "KIT-1", name: "Kit Verão", quantity: 1, unitPriceCents: 100 }],
    shippingCents: 0,
    total: 100,
    totalCents: 100,
    valor: 1,
  }, "203.0.113.10");

  ok("a cobrança acontece", golpe.ok, golpe.ok ? "" : golpe.motivo);
  const p1 = pedidoCriado();
  eq("products_value é o do banco, não o injetado", p1?.corpo.products_value, 14990);
  eq("shipping_value é o do banco, não o injetado", p1?.corpo.shipping_value, 1990);
  eq("o item vai com o preço do banco", p1?.corpo.products[0].unit_value, 14990);

  /* ------------------------------------------------- 2. formato do cliente */
  console.log("\nO QUE A APPMAX RECEBE");
  const cli = enviados.find((e) => e.url.includes("/v1/customers"));
  eq("nome parte em primeiro e último", [cli?.corpo.first_name, cli?.corpo.last_name],
    ["Maria", "Souza"]);
  eq("telefone vai só com dígitos", cli?.corpo.phone, "11988887777");
  eq("CPF vai só com dígitos", cli?.corpo.document_number, "11144477735");
  eq("CEP vai só com dígitos", cli?.corpo.address.postcode, "01310100");
  eq("o IP do comprador é repassado", cli?.corpo.ip, "203.0.113.10");
  eq("produto físico é marcado como physical", p1?.corpo.products[0].type, "physical");

  /* --------------------------------------------------------------- 3. pix */
  console.log("\nPIX");
  eq("devolve o copia-e-cola", golpe.pix?.emv, "00020126BR.GOV.BCB.PIX");
  eq("devolve o QR em base64", golpe.pix?.qrcodeBase64, "iVBORw0KGgo=");
  eq("devolve a expiração que a Appmax mandou", golpe.pix?.expiraEm, "2026-08-25 23:59:00");
  eq("o pedido devolvido é o da Appmax", golpe.gatewayOrderId, "999123");

  /* -------------------------------- 4. conferência de total antes de cobrar */
  console.log("\nVALOR DIVERGENTE NÃO É COBRADO");
  limpar();
  /* A Appmax alega ter entendido R$ 1,69 em vez de R$ 169,80 — o sintoma
     exato de a unidade monetária não ser a que supomos. */
  totalAlegado = 169;

  const divergente = await pagar({
    slug: "oferta-principal", metodo: "pix", comprador: compradorBase,
  }, "203.0.113.11");

  ok("a cobrança é recusada", !divergente.ok, JSON.stringify(divergente));
  ok("o motivo fala em valor divergente",
    (divergente.motivo ?? "").includes("divergente"), divergente.motivo);
  ok("NENHUMA cobrança foi disparada", cobranca() === undefined,
    cobranca() ? cobranca().url : "nenhuma");

  /* ------------------------------------------------------- 5. parcelamento */
  console.log("\nPARCELAS PRESAS AO TETO DO CHECKOUT");
  await criarCheckout("ate-seis", { maxInstallments: 6 });
  limpar();

  /*
   * O corpo abaixo carrega número e CVV de propósito.
   *
   * Não porque a página mande isso — ela manda só o token — mas porque a
   * garantia que interessa é que NEM SE MANDAREM o dado atravessa. Um teste
   * que só envia o token não prova nada: passaria igual se o driver repassasse
   * tudo que recebe.
   */
  const parcelado = await pagar({
    slug: "ate-seis",
    metodo: "credit_card",
    parcelas: 12,
    cartao: {
      token: "tok_cartao", titular: "MARIA S SOUZA", documento: CPF_BOM,
      numero: "4111111111111111", cvv: "737", validade: "12/2030",
    },
    comprador: compradorBase,
  }, "203.0.113.12");

  ok("a cobrança acontece", parcelado.ok, parcelado.ok ? "" : parcelado.motivo);
  eq("12 pedidas viram 6, que é o teto",
    cobranca()?.corpo.payment_data.credit_card.installments, 6);
  eq("o token vai para a Appmax",
    cobranca()?.corpo.payment_data.credit_card.token, "tok_cartao");

  const tudoQueSaiu = JSON.stringify(enviados);
  ok("número de cartão mandado por engano não atravessa",
    !tudoQueSaiu.includes("4111111111111111"),
    tudoQueSaiu.includes("4111111111111111") ? "VAZOU" : "");
  ok("CVV mandado por engano não atravessa",
    !tudoQueSaiu.includes('"737"'),
    tudoQueSaiu.includes('"737"') ? "VAZOU" : "");

  /* ---------------------------------------------------------- 6. validação */
  console.log("\nVALIDAÇÃO ANTES DA REDE");
  limpar();
  const cpfRuim = await pagar({
    slug: "oferta-principal", metodo: "pix",
    comprador: { ...compradorBase, documento: "111.111.111-11" },
  }, "203.0.113.13");
  ok("CPF de dígito repetido é barrado", !cpfRuim.ok && cpfRuim.tipo === "invalido", cpfRuim.motivo);
  ok("e nada foi para a Appmax", enviados.length === 0, `${enviados.length} chamada(s)`);

  limpar();
  const semSobrenome = await pagar({
    slug: "oferta-principal", metodo: "pix",
    comprador: { ...compradorBase, nome: "Maria" },
  }, "203.0.113.13");
  ok("nome sem sobrenome é barrado", !semSobrenome.ok, semSobrenome.motivo);

  limpar();
  const metodoErrado = await pagar({
    slug: "so-pix", metodo: "credit_card", cartao: { token: "x" }, comprador: compradorBase,
  }, "203.0.113.13");
  ok("checkout inexistente é barrado", !metodoErrado.ok, metodoErrado.motivo);

  await criarCheckout("so-pix", { methods: ["pix"] });
  limpar();
  const cartaoNaoAceito = await pagar({
    slug: "so-pix", metodo: "credit_card",
    cartao: { token: "tok", titular: "M S", documento: CPF_BOM },
    comprador: compradorBase,
  }, "203.0.113.14");
  ok("método não habilitado é barrado", !cartaoNaoAceito.ok, cartaoNaoAceito.motivo);
  ok("e nada foi para a Appmax", enviados.length === 0, `${enviados.length} chamada(s)`);

  /* ------------------------------------------------- 7. recusa não é erro */
  console.log("\nRECUSA E ERRO SÃO COISAS DIFERENTES");
  limpar();
  statusCobranca = 422;

  const recusado = await pagar({
    slug: "oferta-principal", metodo: "credit_card", parcelas: 1,
    cartao: { token: "tok_ruim", titular: "MARIA S", documento: CPF_BOM },
    comprador: compradorBase,
  }, "203.0.113.15");

  ok("422 vira recusa, não erro", !recusado.ok && recusado.tipo === "recusado",
    `tipo ${recusado.tipo}`);
  ok("a mensagem do emissor chega ao comprador",
    (recusado.motivo ?? "").includes("recusado"), recusado.motivo);

  limpar();
  statusCobranca = 500;
  const quebrou = await pagar({
    slug: "oferta-principal", metodo: "credit_card", parcelas: 1,
    cartao: { token: "tok", titular: "MARIA S", documento: CPF_BOM },
    comprador: compradorBase,
  }, "203.0.113.16");
  ok("500 vira erro, não recusa", !quebrou.ok && quebrou.tipo === "erro", `tipo ${quebrou.tipo}`);

  /* ------------------------------------------------------ 8. reivindicação */
  console.log("\nA VENDA SABE DE ONDE VEIO");
  const clickId = wc.randomUUID();
  await sql`INSERT INTO click_sessions (click_id, tenant_id, utm_source, utm_campaign)
    VALUES (${clickId}, ${t.id}, 'facebook', 'campanha-x')`;

  limpar();
  const comClique = await pagar({
    slug: "oferta-principal", metodo: "pix", clickId, comprador: compradorBase,
  }, "203.0.113.17");
  ok("a cobrança acontece", comClique.ok, comClique.ok ? "" : comClique.motivo);

  const [claim] = await sql`SELECT click_id, customer FROM order_claims
    WHERE tenant_id = ${t.id} AND gateway_order_id = '999123'`;
  eq("o pedido ficou amarrado ao clique", claim?.click_id, clickId);
  ok("o comprador foi guardado cifrado",
    claim?.customer?.email && !String(claim.customer.email).includes("@"),
    JSON.stringify(claim?.customer?.email ?? null));

  /* Um clickId que não é desta loja não pode roubar a atribuição. */
  const [outra] = await sql`INSERT INTO tenants (name, slug)
    VALUES ('Outra', ${"ck-outra-" + Date.now()}) RETURNING id`;
  const alheio = wc.randomUUID();
  await sql`INSERT INTO click_sessions (click_id, tenant_id) VALUES (${alheio}, ${outra.id})`;

  await sql`DELETE FROM order_claims WHERE tenant_id = ${t.id}`;
  limpar();
  await pagar({
    slug: "oferta-principal", metodo: "pix", clickId: alheio, comprador: compradorBase,
  }, "203.0.113.18");
  const cruzado = await sql`SELECT 1 FROM order_claims WHERE tenant_id = ${t.id}`;
  ok("clique de outra loja não vira reivindicação", cruzado.length === 0,
    `${cruzado.length} reivindicação(ões)`);
  await sql`DELETE FROM tenants WHERE id = ${outra.id}`;

  /* --------------------------------------------------------- 9. limitador */
  console.log("\nTETO DE TENTATIVAS POR IP");
  const ipRobo = "198.51.100.7";
  limpar();

  let barrouEm = null;
  for (let i = 1; i <= 8; i++) {
    const r = await pagar({
      slug: "oferta-principal", metodo: "pix", comprador: compradorBase,
    }, ipRobo);
    if (!r.ok && r.tipo === "limite") { barrouEm = i; break; }
  }
  ok("o mesmo IP é barrado depois de poucas tentativas",
    barrouEm !== null && barrouEm <= 7, `barrou na ${barrouEm ?? "nenhuma"}`);

  const outroIp = await pagar({
    slug: "oferta-principal", metodo: "pix", comprador: compradorBase,
  }, "198.51.100.99");
  ok("outro IP continua passando", outroIp.ok, outroIp.ok ? "" : outroIp.motivo);

  /* Assinatura de teste de cartão: recusa atrás de recusa. */
  const ipCarding = "198.51.100.42";
  statusCobranca = 422;
  let barrouPorRecusa = null;
  for (let i = 1; i <= 5; i++) {
    const r = await pagar({
      slug: "oferta-principal", metodo: "credit_card", parcelas: 1,
      cartao: { token: "tok" + i, titular: "T T", documento: CPF_BOM },
      comprador: compradorBase,
    }, ipCarding);
    if (!r.ok && r.tipo === "limite") { barrouPorRecusa = i; break; }
  }
  ok("recusa repetida barra o IP", barrouPorRecusa !== null && barrouPorRecusa <= 5,
    `barrou na ${barrouPorRecusa ?? "nenhuma"}`);
  statusCobranca = 201;

  /* ---------------------------------------------------- 10. tela e cobrança */
  console.log("\nO QUE A TELA MOSTRA É O QUE SE COBRA");
  const publico = await checkoutPorSlug("oferta-principal");
  const totais = totalDoCheckout(publico);
  eq("o total exibido bate com o do banco", totais.totalCents, 16980);

  limpar();
  await pagar({ slug: "oferta-principal", metodo: "pix", comprador: compradorBase },
    "203.0.113.200");
  const cobrado = pedidoCriado();
  eq("e bate com o que foi pedido ao gateway",
    cobrado.corpo.products_value + cobrado.corpo.shipping_value - cobrado.corpo.discount_value,
    totais.totalCents);

  ok("credencial nunca sai para a página pública",
    !("credentials" in publico) && !JSON.stringify(publico).includes("segredo-456"));

  /* ------------------------------------------------------------- 11. slug */
  console.log("\nENDEREÇO PÚBLICO");
  eq("acento vira letra simples", normalizarSlug("Promoção de Verão"), "promocao-de-verao");
  eq("espaço e símbolo viram hífen", normalizarSlug("Kit 3 peças!!"), "kit-3-pecas");
  eq("hífen sobrando é aparado", normalizarSlug("  --oferta--  "), "oferta");

  /* ---------------------------------------------------------------- fim -- */
  await sql`DELETE FROM tenants WHERE slug = 'checkout-teste'`;

  console.log(`\n${f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)"}`);
  process.exit(f === 0 ? 0 : 1);
})().catch((e) => {
  console.error("\nERRO:", e);
  process.exit(1);
});
