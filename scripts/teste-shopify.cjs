/*
 * Adaptador da Shopify.
 *
 * Os testes daqui miram no que erra CALADO. Adaptador quebrado dá exceção e
 * alguém conserta; adaptador que lê o campo errado devolve uma venda inteira,
 * plausível, com o número errado — e ela vai para o painel e para o CAPI.
 *
 * Três armadilhas específicas desta integração, uma em cada bloco:
 *
 *   dinheiro   "129.95" é decimal, não centavo. Ler como os outros gateways
 *              erra por cem, para cima ou para baixo.
 *   moeda      shop_money x presentment_money. A loja inglesa que vende para
 *              um americano tem os dois, e eles discordam.
 *   repasse    note_attributes é lista de {name,value}. Lido como objeto, o
 *              clickId some e toda venda vira não atribuída.
 *
 *   node scripts/teste-shopify.cjs
 */
const { shopifyAdapter: s } = require("../_tmp/gateways/shopify.js");
const { webcrypto: wc } = require("node:crypto");

let f = 0;
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) f++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${l}`
    + (ok ? "" : `  obtido ${JSON.stringify(got)}, esperado ${JSON.stringify(want)}`));
};

const ler = (corpo, cabecalhos = {}) => s.parse({
  headers: { "x-shopify-topic": "orders/paid", ...cabecalhos },
  rawBody: JSON.stringify(corpo),
  query: {},
});

/* Um pedido mínimo mas realista, no formato que a Shopify entrega. */
const pedido = (extra = {}) => ({
  id: 5300000000001,
  email: "cliente@exemplo.com",
  phone: "+5511987654321",
  currency: "BRL",
  financial_status: "paid",
  total_price: "129.95",
  total_price_set: {
    shop_money: { amount: "129.95", currency_code: "BRL" },
    presentment_money: { amount: "129.95", currency_code: "BRL" },
  },
  total_shipping_price_set: { shop_money: { amount: "19.90", currency_code: "BRL" } },
  total_discounts_set: { shop_money: { amount: "10.00", currency_code: "BRL" } },
  payment_gateway_names: ["shopify_payments"],
  processed_at: "2026-08-20T14:30:00-03:00",
  line_items: [{
    sku: "FLR-001", title: "Sérum Facial", variant_title: "30ml",
    quantity: 2, price: "54.99", product_type: "Skincare",
  }],
  ...extra,
});

(async () => {
  console.log("\n== dinheiro é decimal, não centavo ==");

  const o = await ler(pedido());
  eq('"129.95" vira 12995', o.grossCents, 12995);
  eq('frete "19.90" vira 1990', o.shippingCents, 1990);
  eq('desconto "10.00" vira 1000', o.discountCents, 1000);
  eq('preço do item "54.99" vira 5499', o.items[0].unitPriceCents, 5499);

  /*
   * O caso que o `cents()` dos outros adaptadores erraria: valor decimal
   * redondo, sem centavo escrito. Eles veriam só dígitos e aceitariam como
   * centavos — R$ 130,00 viraria R$ 1,30.
   */
  const redondo = await ler(pedido({
    total_price: "130",
    total_price_set: { shop_money: { amount: "130", currency_code: "BRL" } },
  }));
  eq('"130" é cento e trinta reais, não R$ 1,30', redondo.grossCents, 13000);

  /* Moeda sem centavo: ¥1000 são mil unidades, não cem mil. */
  const iene = await ler(pedido({
    currency: "JPY",
    total_price_set: { shop_money: { amount: "1000", currency_code: "JPY" } },
  }));
  eq("iene não ganha duas casas", iene.grossCents, 1000);
  eq("e a moeda vem junto", iene.currency, "JPY");

  console.log("\n== a moeda é a da LOJA, não a que o comprador viu ==");

  /* Loja inglesa, comprador americano: os dois valores existem e discordam. */
  const gringa = await ler(pedido({
    currency: "USD",
    total_price: "165.00",
    total_price_set: {
      shop_money: { amount: "129.95", currency_code: "GBP" },
      presentment_money: { amount: "165.00", currency_code: "USD" },
    },
  }));
  eq("moeda é a do lojista", gringa.currency, "GBP");
  eq("e o valor também", gringa.grossCents, 12995);

  console.log("\n== note_attributes é lista, e é por onde o clickId volta ==");

  const clickId = "3f2b9c14-8a7d-4e61-b2c3-9d5e7a1f04bb";
  const comClick = await ler(pedido({
    note_attributes: [
      { name: "rr_click_id", value: clickId },
      { name: "observacao", value: "entregar de manhã" },
    ],
  }));
  eq("o clickId aparece entre os valores do repasse",
    Object.values(comClick.passthrough).includes(clickId), true);
  eq("e o resto do campo livre vem junto",
    comClick.passthrough["note.observacao"], "entregar de manhã");

  /* Lida como objeto, a lista daria repasse vazio e a venda perderia a origem. */
  eq("lista vazia não inventa repasse",
    Object.keys((await ler(pedido({ note_attributes: [] }))).passthrough).length, 0);

  console.log("\n== o endereço, que é o motivo de a Shopify valer a pena ==");

  const comEndereco = await ler(pedido({
    customer: { first_name: "Ana", last_name: "Nogueira", email: "ana@exemplo.com" },
    shipping_address: {
      first_name: "Ana", last_name: "Nogueira",
      city: "Belo Horizonte", province: "Minas Gerais", province_code: "MG",
      zip: "30140-071", country: "Brazil", country_code: "BR",
    },
  }));
  eq("nome montado do endereço", comEndereco.customer.name, "Ana Nogueira");
  eq("cidade", comEndereco.customer.city, "Belo Horizonte");
  eq("estado vem como sigla", comEndereco.customer.state, "MG");
  eq("CEP", comEndereco.customer.zip, "30140-071");
  eq("país como sigla", comEndereco.customer.country, "BR");
  eq("e-mail do pedido", comEndereco.customer.email, "cliente@exemplo.com");

  console.log("\n== as UTMs escondidas no landing_site ==");

  const comUtm = await ler(pedido({
    landing_site: "/products/serum?utm_source=facebook&utm_campaign=frio-01&fbclid=ABC123",
    referring_site: "https://l.facebook.com/",
  }));
  eq("utm_source", comUtm.attribution.utmSource, "facebook");
  eq("utm_campaign", comUtm.attribution.utmCampaign, "frio-01");
  eq("referrer", comUtm.attribution.referrer, "https://l.facebook.com/");
  eq("fbclid vira fbc no formato da Meta",
    /^fb\.1\.\d+\.ABC123$/.test(comUtm.attribution.fbc), true);

  console.log("\n== status ==");

  eq("paid é venda", (await ler(pedido())).status, "paid");
  eq("pending fica pendente",
    (await ler(pedido({ financial_status: "pending" }))).status, "pending");
  /* Autorização é reserva no cartão, e reserva expira. Não é faturamento. */
  eq("authorized NÃO é pago",
    (await ler(pedido({ financial_status: "authorized" }))).status, "pending");
  eq("refunded",
    (await ler(pedido({ financial_status: "refunded" }))).status, "refunded");

  /*
   * Cancelado antes de pagar mantém financial_status "pending" — só o
   * `cancelled_at` denuncia. Sem lê-lo, o pedido ficaria pendente para sempre.
   */
  eq("cancelled_at manda, mesmo com financial_status pendente",
    (await ler(pedido({ financial_status: "pending", cancelled_at: "2026-08-21T10:00:00Z" }))).status,
    "canceled");
  eq("mas estorno ganha do cancelamento",
    (await ler(pedido({ financial_status: "refunded", cancelled_at: "2026-08-21T10:00:00Z" }))).status,
    "refunded");

  console.log("\n== a taxa fica indefinida, e isso é de propósito ==");
  /* Zero informado venceria a tabela de taxas; indefinido deixa ela estimar. */
  eq("sem taxa no payload, sem taxa inventada", o.feeCents, undefined);

  console.log("\n== meio de pagamento vira categoria, para a tabela de taxas ==");
  const cartao = await ler(pedido({ payment_gateway_names: ["shopify_payments"] }));
  eq("shopify_payments e cartao", cartao.paymentMethod, "credit_card");
  eq("paypal e carteira",
    (await ler(pedido({ payment_gateway_names: ["paypal"] }))).paymentMethod, "wallet");
  /* Manual nao passa por adquirente: taxa de cartao aqui comeria lucro que existe. */
  eq("manual nao e cartao",
    (await ler(pedido({ payment_gateway_names: ["manual"] }))).paymentMethod, "other");
  eq("sem meio informado, nao inventa",
    (await ler(pedido({ payment_gateway_names: [] }))).paymentMethod, "other");


  console.log("\n== o que NÃO é venda ==");

  eq("notificação de teste do admin não entra",
    await ler(pedido(), { "x-shopify-test": "true" }), null);
  eq("evento de carrinho não é venda",
    await s.parse({
      headers: { "x-shopify-topic": "carts/update" },
      rawBody: JSON.stringify({ id: 1, token: "abc" }), query: {},
    }), null);

  console.log("\n== estorno ==");

  /*
   * `refunds/create` tem que ser IGNORADO. Aceita-lo regravaria o pedido com o
   * valor DEVOLVIDO no lugar do valor VENDIDO — um estorno parcial de R$ 20
   * num pedido de R$ 129,95 deixaria o pedido valendo R$ 20 para sempre,
   * porque "estornado" tem posto mais alto que "pago" e nada corrige depois.
   * Faturamento que encolhe sozinho nao levanta suspeita de ninguem.
   */
  eq("refunds/create nao vira pedido",
    await s.parse({
      headers: { "x-shopify-topic": "refunds/create" },
      rawBody: JSON.stringify({
        id: 900, order_id: 5300000000001,
        transactions: [{ amount: "20.00", currency: "BRL" }],
      }),
      query: {},
    }), null);

  /* O caminho de verdade do estorno, com o total do pedido preservado. */
  const estornado = await s.parse({
    headers: { "x-shopify-topic": "orders/updated" },
    rawBody: JSON.stringify(pedido({ financial_status: "partially_refunded" })),
    query: {},
  });
  eq("orders/updated marca o estorno", estornado.status, "refunded");
  eq("e mantem o valor do PEDIDO, nao o do estorno", estornado.grossCents, 12995);

  console.log("\n== dedupe pelo id da entrega ==");
  const comId = await ler(pedido(), { "x-shopify-webhook-id": "wh-42" });
  eq("usa o id do cabeçalho quando vem", comId.gatewayEventId, "wh-42");
  eq("e sintetiza quando não vem", o.gatewayEventId, "5300000000001:paid");

  console.log("\n== assinatura ==");

  const segredo = "shpss_segredo_de_teste";
  const corpo = JSON.stringify(pedido());
  const chave = await wc.subtle.importKey(
    "raw", new TextEncoder().encode(segredo),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = Buffer.from(
    await wc.subtle.sign("HMAC", chave, new TextEncoder().encode(corpo)),
  ).toString("base64");

  const verificar = (hmac, cred, body = corpo) => s.verify(
    { headers: hmac === null ? {} : { "x-shopify-hmac-sha256": hmac }, rawBody: body, query: {} },
    "segredo-da-url",
    cred,
  );

  eq("assinatura correta passa",
    (await verificar(mac, { webhookSecret: segredo })).ok, true);

  /*
   * O corpo CRU importa: reserializar o JSON muda um espaço e o HMAC não fecha
   * mais. Este teste existe para quem for otimizar o roteador e resolver
   * passar o objeto já parseado adiante.
   */
  eq("corpo alterado em um byte não passa",
    (await verificar(mac, { webhookSecret: segredo }, corpo + " ")).ok, false);

  eq("assinatura de outro segredo não passa",
    (await verificar(mac, { webhookSecret: "outro" })).ok, false);

  /* Sem segredo cadastrado degrada, não bloqueia: o segredo da URL ainda vale. */
  const semCred = await verificar(mac, {});
  eq("sem segredo cadastrado, degrada", semCred.ok, false);
  eq("e diz que o motivo é a falta, não a invalidez", semCred.reason, "sem_assinatura");

  const semHeader = await verificar(null, { webhookSecret: segredo });
  eq("sem cabeçalho de assinatura, recusa", semHeader.ok, false);
  eq("e diz que faltou o cabeçalho", semHeader.reason, "assinatura ausente");

  /* Hexadecimal é o formato da MillionsPay; a Shopify manda base64. */
  eq("assinatura em formato errado não derruba, só recusa",
    (await verificar("nao-e-base64-valido-!!!", { webhookSecret: segredo })).ok, false);

  console.log("\n== pedido espelho de outra cobranca ==");

  /*
   * O app da Pagou cria o pedido na Shopify e escreve a referencia nas tags.
   * Sem reconhecer isso, a mesma venda entra duas vezes — foi o que dobrou o
   * faturamento numa loja real: R$ 10,00 para um pagamento de R$ 5,00.
   */
  const espelho = await ler(pedido({
    tags: "Pagou, PIX, TXN-01a04f12-e394-732c-9d61-cabd80d286ec",
    note: "Pagamento via Pagou — transacao #01a04f12-e394-732c-9d61-cabd80d286ec\nCPF: 08455633603",
    shipping_address: { city: "Betim", province_code: "MG", zip: "32600-000", country_code: "BR" },
  }));
  eq("aponta para a transacao da pagou",
    espelho.enriquece, { gateway: "pagou", gatewayOrderId: "01a04f12-e394-732c-9d61-cabd80d286ec" });
  /* O CPF so existe na observacao: a Shopify nao tem campo para ele, e a
     pagou.ai nao devolve em consulta nenhuma. */
  eq("le o CPF da observacao", espelho.customer.document, "08455633603");
  eq("e traz o endereco junto", espelho.customer.zip, "32600-000");

  /* Pedido normal nao pode virar enriquecimento por acidente. */
  eq("pedido sem referencia nao enriquece nada", (await ler(pedido())).enriquece, undefined);
  eq("tag de outra coisa tambem nao",
    (await ler(pedido({ tags: "promocao, TXN-123" }))).enriquece, undefined);


  console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
  process.exit(f === 0 ? 0 : 1);
})();
