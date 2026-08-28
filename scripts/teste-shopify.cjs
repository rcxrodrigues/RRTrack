/*
 * O pedido que vai para a Shopify, conferido antes de existir venda.
 *
 * Este teste existe por um motivo específico: tudo que ele cobre só falharia na
 * primeira venda de verdade, depois do dinheiro ter entrado. Um nome de campo
 * errado no `orderCreate` não dá erro de compilação nem de lint — dá um pedido
 * recusado pela Shopify, com o cartão já debitado e o comprador esperando uma
 * encomenda que ninguém separou.
 *
 * O que ele NÃO prova: que os nomes de campo são os que a Shopify espera. Isso
 * só a Shopify responde. O que ele prova é que, dados os nomes certos, o valor
 * que chega em cada um é o valor certo — que é a metade que depende de nós, e
 * a metade onde já erramos antes (ver `valorCru`, `paid_amount`, `sck`).
 */
const { strict: assert } = require("node:assert");

const {
  precoParaCentavos, centavosParaPreco, partirNome, telefoneE164,
  gidVariante, normalizarDominio, montarPedido,
} = require("../_tmp/checkout/shopify.js");

let falhas = 0;
const ok = (rotulo, condicao, extra = "") => {
  if (!condicao) falhas++;
  console.log(`  ${condicao ? "ok  " : "FALHA"} | ${rotulo}${extra ? "  → " + extra : ""}`);
};

/* ------------------------------------------------------------- dinheiro -- */
console.log("\nDINHEIRO — onde um centavo some sem ninguém ver");

/*
 * `Number("19.99") * 100` dá 1998.9999999999998, e `Math.round` salva por
 * sorte. Em `0.29` a sorte acaba: 28.999999999999996. Um centavo a menos por
 * item vira divergência na conciliação que ninguém acha a origem.
 */
ok("19.99 vira 1999", precoParaCentavos("19.99") === 1999, String(precoParaCentavos("19.99")));
ok("0.29 vira 29", precoParaCentavos("0.29") === 29, String(precoParaCentavos("0.29")));
ok("139.90 vira 13990", precoParaCentavos("139.90") === 13990, String(precoParaCentavos("139.90")));
ok("inteiro sem decimal", precoParaCentavos("97") === 9700, String(precoParaCentavos("97")));
ok("um decimal só", precoParaCentavos("97.5") === 9750, String(precoParaCentavos("97.5")));
ok("vazio vira zero", precoParaCentavos("") === 0);

ok("13990 vira 139.90", centavosParaPreco(13990) === "139.90", centavosParaPreco(13990));
ok("29 vira 0.29", centavosParaPreco(29) === "0.29", centavosParaPreco(29));
ok("9700 vira 97.00", centavosParaPreco(9700) === "97.00", centavosParaPreco(9700));

/* A volta tem que ser exata: é o mesmo número atravessando dois sistemas. */
for (const c of [1, 29, 99, 100, 1999, 13990, 50000, 123456]) {
  const volta = precoParaCentavos(centavosParaPreco(c));
  if (volta !== c) { falhas++; console.log(`  FALHA | ida e volta de ${c} deu ${volta}`); }
}
ok("ida e volta preserva o valor", true);

/* ----------------------------------------------------------------- nome -- */
console.log("\nNOME — a Shopify guarda em dois campos, o checkout pede um");

ok("nome simples", partirNome("Ryan Rodrigues").ultimo === "Rodrigues");
ok("nome composto vai inteiro pro sobrenome",
  partirNome("Maria da Silva Santos").ultimo === "da Silva Santos",
  partirNome("Maria da Silva Santos").ultimo);
ok("nome de uma palavra não inventa sobrenome", partirNome("Madonna").ultimo === "");
ok("espaço sobrando não vira campo vazio", partirNome("  Ana   Paula  ").primeiro === "Ana");

/* ------------------------------------------------------------- telefone -- */
console.log("\nTELEFONE — E.164 ou nenhum; formato errado derruba o pedido");

ok("celular com DDD", telefoneE164("(31) 99410-7924") === "+5531994107924", telefoneE164("(31) 99410-7924"));
ok("fixo com DDD", telefoneE164("3133334444") === "+553133334444", telefoneE164("3133334444"));
ok("já com o país", telefoneE164("+55 31 99410-7924") === "+5531994107924");
/*
 * Número curto demais some em vez de ir torto. Perder o telefone é pequeno;
 * perder o pedido inteiro por causa dele é que não pode.
 */
ok("número curto some", telefoneE164("99410") === undefined);
ok("vazio some", telefoneE164("") === undefined);
ok("indefinido some", telefoneE164(undefined) === undefined);

/* ------------------------------------------------------------- domínio -- */
console.log("\nDOMÍNIO — sempre o interno, com ou sem ajuda de quem digitou");

ok("nome puro ganha sufixo", normalizarDominio("minhaloja") === "minhaloja.myshopify.com");
ok("com https e barra", normalizarDominio("https://minhaloja.myshopify.com/") === "minhaloja.myshopify.com");
ok("caixa alta desce", normalizarDominio("MinhaLoja.myshopify.com") === "minhaloja.myshopify.com");

/* ------------------------------------------------------------- variante -- */
ok("GID passa intacto", gidVariante("gid://shopify/ProductVariant/42") === "gid://shopify/ProductVariant/42");
ok("id cru vira GID", gidVariante("42") === "gid://shopify/ProductVariant/42");

/* --------------------------------------------------------------- pedido -- */
console.log("\nPEDIDO — o payload inteiro, do jeito que sairia numa venda real");

const venda = montarPedido({
  buyer: {
    name: "Giovana Rodrigues Pinheiro",
    email: "rxryan1@gmail.com",
    phone: "(31) 99410-7924",
    document: "12345678909",
    zip: "32143-670",
    street: "Rua Vinte e Seis",
    number: "23",
    neighborhood: "Morada Nova",
    city: "Contagem",
    state: "MG",
  },
  items: [
    { sku: "P1", name: "Produto", quantity: 2, unitPriceCents: 6995, shopifyVariantId: "gid://shopify/ProductVariant/777" },
  ],
  shippingCents: 2790,
  gatewayOrderId: "ped-123",
  gateway: "appmax",
});

const o = venda.order;

ok("marcado como pago", o.financialStatus === "PAID");
ok("moeda em real", o.currency === "BRL");

/*
 * O total da transação é o que vira faturamento na Shopify. Errar aqui faz os
 * dois painéis divergirem para sempre, e o frete é justamente onde é fácil
 * errar: 2 × 69,95 + 27,90 = 167,80.
 */
ok("transação soma produtos e frete",
  o.transactions[0].amountSet.shopMoney.amount === "167.80",
  o.transactions[0].amountSet.shopMoney.amount);
ok("transação é venda bem-sucedida",
  o.transactions[0].kind === "SALE" && o.transactions[0].status === "SUCCESS");

ok("frete vai como linha própria",
  o.shippingLines[0].priceSet.shopMoney.amount === "27.90",
  o.shippingLines[0].priceSet.shopMoney.amount);

ok("item usa a variante", o.lineItems[0].variantId === "gid://shopify/ProductVariant/777");
ok("item leva o NOSSO preço, não o da Shopify",
  o.lineItems[0].priceSet.shopMoney.amount === "69.95",
  o.lineItems[0].priceSet.shopMoney.amount);
ok("quantidade preservada", o.lineItems[0].quantity === 2);

ok("endereço montado com rua e número",
  o.shippingAddress.address1 === "Rua Vinte e Seis, 23", o.shippingAddress.address1);
ok("estado como sigla", o.shippingAddress.provinceCode === "MG");
ok("país fixo em BR", o.shippingAddress.countryCode === "BR");
ok("cobrança repete a entrega", o.billingAddress.zip === "32143-670");

ok("cliente entra por upsert", o.customer.toUpsert.email === "rxryan1@gmail.com");
ok("sobrenome composto no cliente",
  o.customer.toUpsert.lastName === "Rodrigues Pinheiro", o.customer.toUpsert.lastName);

ok("estoque baixa respeitando a política",
  venda.options.inventoryBehaviour === "DECREMENT_OBEYING_POLICY");
ok("quem avisa o comprador é a Shopify", venda.options.sendReceipt === true);
ok("o pedido do gateway fica rastreável", String(o.note).includes("ped-123"));

/* ------------------------------------------------- os casos incompletos -- */
console.log("\nINCOMPLETO — o que falta não pode derrubar o que já foi pago");

const semEndereco = montarPedido({
  buyer: { name: "Ana Souza", email: "a@b.com" },
  items: [{ sku: "X", name: "Item", quantity: 1, unitPriceCents: 1000 }],
  shippingCents: 0,
  gatewayOrderId: "p2",
  gateway: "appmax",
});

/*
 * Meio endereço faz a Shopify recusar o pedido inteiro. Como a cobrança já
 * aconteceu, é melhor o pedido entrar sem endereço — o lojista completa — do
 * que não entrar.
 */
ok("endereço incompleto some inteiro", semEndereco.order.shippingAddress === undefined);
ok("sem frete não cria linha de frete", semEndereco.order.shippingLines === undefined);
ok("item sem variante entra pelo título", semEndereco.order.lineItems[0].title === "Item");
ok("item sem variante não inventa variante", semEndereco.order.lineItems[0].variantId === undefined);

const semTelefone = montarPedido({
  buyer: { name: "Ana Souza", email: "a@b.com", phone: "123" },
  items: [{ sku: "X", name: "Item", quantity: 1, unitPriceCents: 1000 }],
  shippingCents: 0,
  gatewayOrderId: "p3",
  gateway: "appmax",
});
ok("telefone inválido não vai junto", semTelefone.order.phone === undefined);

assert.ok(true);
console.log(`\n${falhas === 0 ? "TODOS PASSARAM" : falhas + " FALHA(S)"}`);
process.exit(falhas === 0 ? 0 : 1);
