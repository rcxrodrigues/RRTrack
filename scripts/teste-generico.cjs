/*
 * Entrada por API — o adaptador coringa.
 *
 * A asserção que mais importa é a de dinheiro. `19990` sozinho tanto pode ser
 * R$ 199,90 quanto R$ 19.990,00, e adivinhar pelo formato do número erra cem
 * vezes para cima em metade dos casos — valor que a Meta usa para otimizar e
 * que o painel exibe como ROAS. Por isso a regra não adivinha: `valor` é sempre
 * na moeda, `valor_centavos` é sempre em centavos, e é o CAMPO que decide.
 *
 * Depois dela vem a de nomes. Errar o nome de um campo não dá erro: dá venda
 * sem chave de correspondência, que é uma falha silenciosa — a venda entra, o
 * disparo sai, e o pixel recebe menos do que podia sem ninguém notar.
 *
 *   npx tsc src/gateways/generico.ts --outDir _tmp --target ES2022 \
 *     --module commonjs --moduleResolution node --skipLibCheck --esModuleInterop --strict
 *   node scripts/teste-generico.cjs
 */
const { genericoAdapter: g } = require("../_tmp/gateways/generico.js");

let f = 0;
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) f++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${l}` + (ok ? "" : `  obtido ${JSON.stringify(got)}, esperado ${JSON.stringify(want)}`));
};

const ler = (o) => g.parse({ headers: {}, rawBody: JSON.stringify(o), query: {} });

(async () => {
  console.log("\n== dinheiro: o campo decide, não o formato ==");

  const emReais = await ler({ pedido_id: "1", status: "pago", valor: 199.90 });
  eq("valor 199.90 vira 19990 centavos", emReais.grossCents, 19990);

  const emCentavos = await ler({ pedido_id: "1", status: "pago", valor_centavos: 19990 });
  eq("valor_centavos 19990 fica 19990", emCentavos.grossCents, 19990);

  /* O mesmo número nos dois campos tem de dar resultados diferentes. */
  const inteiroEmReais = await ler({ pedido_id: "1", status: "pago", valor: 19990 });
  eq("valor 19990 vira R$ 19.990,00", inteiroEmReais.grossCents, 1999000);

  eq("BR: 1.234,56", (await ler({ pedido_id: "1", status: "pago", valor: "1.234,56" })).grossCents, 123456);
  eq("US: 1234.56", (await ler({ pedido_id: "1", status: "pago", valor: "1234.56" })).grossCents, 123456);
  eq("com símbolo: R$ 99,90", (await ler({ pedido_id: "1", status: "pago", valor: "R$ 99,90" })).grossCents, 9990);

  console.log("\n== sem valor, soma os itens ==");
  const porItens = await ler({
    pedido_id: "2", status: "pago",
    itens: [
      { nome: "Kit", quantidade: 2, preco: 89.90 },
      { nome: "Frete grátis", quantidade: 1, preco: 0 },
    ],
  });
  eq("2 × 89,90", porItens.grossCents, 17980);
  eq("dois itens", porItens.items.length, 2);
  eq("quantidade lida", porItens.items[0].quantity, 2);

  console.log("\n== português e inglês dão o mesmo resultado ==");
  const pt = await ler({
    pedido_id: "3", status: "pago", valor: 100, moeda: "brl", metodo: "cartao", parcelas: 3,
    cliente: { nome: "Ana Lima", email: "ANA@Ex.com ", telefone: "(11) 99999-8888", cep: "01310-100", cidade: "São Paulo", estado: "SP" },
  });
  const en = await ler({
    order_id: "3", status: "paid", amount: 100, currency: "brl", payment_method: "credit_card", installments: 3,
    customer: { name: "Ana Lima", email: "ANA@Ex.com ", phone: "(11) 99999-8888", zip: "01310-100", city: "São Paulo", state: "SP" },
  });

  eq("mesmo pedido", [pt.gatewayOrderId, en.gatewayOrderId], ["3", "3"]);
  eq("mesmo status", [pt.status, en.status], ["paid", "paid"]);
  eq("mesmo valor", [pt.grossCents, en.grossCents], [10000, 10000]);
  eq("mesmo método", [pt.paymentMethod, en.paymentMethod], ["credit_card", "credit_card"]);
  eq("mesmas parcelas", [pt.installments, en.installments], [3, 3]);
  eq("mesmo cliente", pt.customer, en.customer);
  eq("moeda em maiúscula", pt.currency, "BRL");
  eq("CEP preservado como veio", pt.customer.zip, "01310-100");

  console.log("\n== endereço aninhado não se perde ==");
  const aninhado = await ler({
    pedido_id: "4", status: "pago", valor: 50,
    cliente: {
      nome: "Bruno", email: "b@ex.com",
      endereco: { cep: "20040-020", cidade: "Rio de Janeiro", estado: "RJ", pais: "br" },
    },
  });
  eq("CEP do endereço", aninhado.customer.zip, "20040-020");
  eq("cidade do endereço", aninhado.customer.city, "Rio de Janeiro");
  eq("estado do endereço", aninhado.customer.state, "RJ");

  console.log("\n== o clickId acha o caminho de volta ==");
  const direto = await ler({ pedido_id: "5", status: "pago", valor: 10, click_id: "abc-123" });
  eq("click_id no topo", direto.passthrough.click_id, "abc-123");

  const noSck = await ler({ pedido_id: "5", status: "pago", valor: 10, sck: "def-456" });
  eq("sck", noSck.passthrough.sck, "def-456");

  const noMeta = await ler({ pedido_id: "5", status: "pago", valor: 10, metadata: { click_id: "ghi-789", pedido_loja: "X" } });
  eq("dentro de metadata", noMeta.passthrough.click_id, "ghi-789");
  eq("e o resto do metadata vem junto", noMeta.passthrough.pedido_loja, "X");

  console.log("\n== envelope e estados ==");
  const embrulhado = await ler({ evento: "venda", pedido: { pedido_id: "6", status: "pago", valor: 10 } });
  eq("aceita embrulhado em 'pedido'", embrulhado.gatewayOrderId, "6");

  eq("estado desconhecido é ignorado", await ler({ pedido_id: "7", status: "sei_la", valor: 10 }), null);
  eq("sem id é ignorado", await ler({ status: "pago", valor: 10 }), null);
  eq("estornado", (await ler({ pedido_id: "8", status: "estornado", valor: 10 })).status, "refunded");
  eq("refunded", (await ler({ pedido_id: "8", status: "refunded", valor: 10 })).status, "refunded");
  eq("cancelado", (await ler({ pedido_id: "8", status: "cancelado", valor: 10 })).status, "canceled");

  console.log("\n== o mesmo POST repetido não vira venda dupla ==");
  const a = await ler({ pedido_id: "9", status: "pago", valor: 10 });
  const b = await ler({ pedido_id: "9", status: "pago", valor: 10 });
  eq("mesmo id de evento", a.gatewayEventId, b.gatewayEventId);

  const mudou = await ler({ pedido_id: "9", status: "estornado", valor: 10 });
  eq("mudança de estado passa", mudou.gatewayEventId !== a.gatewayEventId, true);

  console.log("\n== verify pede a barreira do segredo ==");
  const v = await g.verify({ headers: {}, rawBody: "{}", query: {} }, "s");
  eq("declara que não assina", [v.ok, v.reason], [false, "sem_assinatura"]);

  console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
  process.exit(f === 0 ? 0 : 1);
})();
