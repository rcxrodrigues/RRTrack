/*
 * Entrada por API, contra o servidor de verdade.
 *
 * O teste unitário prova que o adaptador lê o payload. Este prova o resto do
 * caminho: que a rota existe no deploy, que o segredo barra quem não o tem, que
 * a venda empurrada acha a sessão do navegador pelo clickId e que o POST
 * repetido não vira venda dobrada.
 *
 *   node scripts/teste-api-entrada.mjs "$(node scripts/seed.mjs)"
 */
import { neon } from "@neondatabase/serverless";
import { webcrypto as wc } from "node:crypto";
process.loadEnvFile(".env");

const sql = neon(process.env.DATABASE_URL);
const BASE = process.env.RR_BASE ?? "https://rr-track.vercel.app";
const s = JSON.parse(process.argv[2]);

let f = 0;
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) f++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${l}` + (ok ? "" : `  obtido ${JSON.stringify(got)}, esperado ${JSON.stringify(want)}`));
};

const segredo = s.gateways.api.webhookSecret;
const empurrar = (corpo, seg = segredo) =>
  fetch(`${BASE}/api/pedidos/${seg}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });

/* Uma sessão de navegador, como o rr.js teria criado. */
const click = wc.randomUUID();
await sql`INSERT INTO click_sessions (click_id, tenant_id, utm_source, utm_campaign, fbp, ip, user_agent)
  VALUES (${click}, ${s.tenantId}, 'FB', 'Campanha Teste|1201', 'fb.1.1700000000000.987654',
    '200.100.50.25', 'Mozilla/5.0 (iPhone)')`;

const pedidoId = "API-" + Date.now();

console.log("\n== o segredo é a barreira ==");
const semSegredo = await empurrar({ pedido_id: "X", status: "pago", valor: 10 }, "whsec_errado");
eq("segredo errado é recusado", semSegredo.status, 404);

console.log("\n== venda empurrada entra atribuída ==");
const res = await empurrar({
  pedido_id: pedidoId,
  status: "pago",
  valor: 297.00,
  moeda: "BRL",
  metodo: "pix",
  click_id: click,
  cliente: {
    nome: "Carla Menezes",
    email: "carla@exemplo.com.br",
    telefone: "(11) 98765-4321",
    documento: "390.533.447-05",
    cep: "01310-100",
    cidade: "São Paulo",
    estado: "SP",
    nascimento: "1990-05-12",
    genero: "f",
  },
  itens: [{ sku: "KIT-3", nome: "Kit 3 unidades", quantidade: 1, preco: 297.00 }],
});

const json = await res.json();
eq("aceita", res.status, 200);
eq("pedido reconhecido", json.pedido, pedidoId);
eq("estado pago", json.status, "paid");
eq("atribuída pelo clickId", json.atribuicao, "click_id");

const [venda] = await sql`SELECT status, gross_cents, click_id, attribution_method, customer
  FROM orders WHERE tenant_id = ${s.tenantId} AND gateway_order_id = ${pedidoId}`;

eq("gravada", venda.status, "paid");
eq("R$ 297,00 em centavos", Number(venda.gross_cents), 29700);
eq("amarrada à sessão", venda.click_id, click);
eq("comprador cifrado em repouso", venda.customer.email.includes("."), true);
eq("não guardou o e-mail em claro", venda.customer.email.includes("@"), false);

console.log("\n== chaves de correspondência que saíram ==");
const disparos = await sql`SELECT d.match_keys, d.status FROM dispatches d
  JOIN orders o ON o.id = d.order_id
  WHERE o.gateway_order_id = ${pedidoId} AND o.tenant_id = ${s.tenantId}`;

if (disparos.length === 0) {
  console.log("  --   | nenhum destino configurado nesta semente (esperado)");
} else {
  const chaves = disparos[0].match_keys ?? [];
  console.log(`  --   | ${chaves.length} chaves: ${chaves.join(", ")}`);
  for (const esperada of ["em", "ph", "fn", "ln", "ct", "st", "zp", "db", "ge"]) {
    eq(`chave ${esperada}`, chaves.includes(esperada), true);
  }
}

console.log("\n== o mesmo POST repetido não dobra a venda ==");
await empurrar({ pedido_id: pedidoId, status: "pago", valor: 297.00, click_id: click });

const [{ c }] = await sql`SELECT count(*) c FROM orders
  WHERE tenant_id = ${s.tenantId} AND gateway_order_id = ${pedidoId}`;
eq("uma venda só", Number(c), 1);

const [{ c: d }] = await sql`SELECT count(*) c FROM dispatches disp
  JOIN orders o ON o.id = disp.order_id
  WHERE o.gateway_order_id = ${pedidoId} AND o.tenant_id = ${s.tenantId}`;
eq("sem disparo extra", Number(d), disparos.length);

console.log("\n== estorno depois do pago passa; pendente atrasado não ==");
await empurrar({ pedido_id: pedidoId, status: "pendente", valor: 297.00, click_id: click });
const [aindaPago] = await sql`SELECT status FROM orders
  WHERE tenant_id = ${s.tenantId} AND gateway_order_id = ${pedidoId}`;
eq("pendente atrasado não reabre a venda", aindaPago.status, "paid");

await empurrar({ pedido_id: pedidoId, status: "estornado", valor: 297.00, click_id: click });
const [estornada] = await sql`SELECT status FROM orders
  WHERE tenant_id = ${s.tenantId} AND gateway_order_id = ${pedidoId}`;
eq("estorno avança", estornada.status, "refunded");

/*
 * Varias credenciais, cada uma com o seu nome e o seu segredo.
 *
 * O ponto de nomear nao e organizacao: e poder revogar UMA sem derrubar as
 * outras. Se apagar a do parceiro derruba a do ERP junto, o lojista descobre
 * pelo faturamento parando — e nao ha erro nenhum dizendo por que.
 */
console.log("\n== credenciais nomeadas convivem ==");

const [erp] = await sql`
  INSERT INTO gateway_connections (tenant_id, gateway, label, credentials, webhook_secret, active)
  VALUES (${s.tenantId}, 'api', 'ERP da loja', '{}'::jsonb, ${'whsec_erp_' + Date.now()}, true)
  RETURNING id, webhook_secret`;
const [parceiro] = await sql`
  INSERT INTO gateway_connections (tenant_id, gateway, label, credentials, webhook_secret, active)
  VALUES (${s.tenantId}, 'api', 'Parceiro', '{}'::jsonb, ${'whsec_parc_' + Date.now()}, true)
  RETURNING id, webhook_secret`;

const vendaErp = "ERP-" + Date.now();
const vendaParc = "PARC-" + Date.now();

eq("a credencial do ERP entrega",
  (await empurrar({ pedido_id: vendaErp, status: "pago", valor: 100, click_id: click },
    erp.webhook_secret)).status, 200);
eq("a do parceiro tambem",
  (await empurrar({ pedido_id: vendaParc, status: "pago", valor: 200, click_id: click },
    parceiro.webhook_secret)).status, 200);

const ambas = await sql`SELECT gateway_order_id FROM orders
  WHERE tenant_id = ${s.tenantId} AND gateway_order_id IN (${vendaErp}, ${vendaParc})`;
eq("as duas vendas entraram, na mesma loja", ambas.length, 2);

/* Revogar uma nao pode calar a outra — e a razao de existirem separadas. */
await sql`UPDATE gateway_connections SET active = false WHERE id = ${erp.id}`;

eq("credencial revogada para de entregar",
  (await empurrar({ pedido_id: "ERP-2", status: "pago", valor: 100 }, erp.webhook_secret)).status, 404);
eq("e a outra segue funcionando",
  (await empurrar({ pedido_id: "PARC-2-" + Date.now(), status: "pago", valor: 200, click_id: click },
    parceiro.webhook_secret)).status, 200);


/*
 * O token no cabecalho, que e como credencial de API se entrega.
 *
 * O segredo no caminho da URL continua valendo — quem ja configurou nao pode
 * parar de entregar venda porque mudamos de ideia sobre estilo. Mas URL vaza
 * por onde URL passa: log de servidor, log de proxy, Referer, historico. O
 * cabecalho nao.
 */
console.log("\n== token no cabecalho Authorization ==");

const porToken = (corpo, token, prefixo = "Bearer ") =>
  fetch(`${BASE}/api/pedidos`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: prefixo + token }),
    },
    body: JSON.stringify(corpo),
  });

const vendaToken = "TOK-" + Date.now();
eq("Bearer com o token certo entrega",
  (await porToken({ pedido_id: vendaToken, status: "pago", valor: 150, click_id: click },
    parceiro.webhook_secret)).status, 200);

const [gravada] = await sql`SELECT gross_cents, attribution_method FROM orders
  WHERE tenant_id = ${s.tenantId} AND gateway_order_id = ${vendaToken}`;
eq("e a venda entra igual a que veio pela URL", Number(gravada?.gross_cents), 15000);
eq("com a mesma atribuicao", gravada?.attribution_method, "click_id");

/* Metade dos clientes HTTP manda o valor cru; recusar viraria uma tarde de
   depuracao para descobrir que faltava escrever "Bearer". */
eq("token sem a palavra Bearer tambem serve",
  (await porToken({ pedido_id: "TOK-CRU-" + Date.now(), status: "pago", valor: 150, click_id: click },
    parceiro.webhook_secret, "")).status, 200);

eq("token errado e recusado",
  (await porToken({ pedido_id: "X", status: "pago", valor: 1 }, "rrt_naoexiste")).status, 404);
eq("sem cabecalho nenhum, 401",
  (await porToken({ pedido_id: "X", status: "pago", valor: 1 }, null)).status, 401);

/* A credencial revogada tambem nao vale pelo cabecalho. */
eq("credencial revogada nao vale nem por token",
  (await porToken({ pedido_id: "X", status: "pago", valor: 1 }, erp.webhook_secret)).status, 404);


/*
 * O payload da Utmify, no formato exato da documentacao deles.
 *
 * Quem ja integrou com a Utmify aponta a URL para ca e nao mexe em mais nada.
 * Isso so vale se cada campo do formato deles chegar no lugar certo aqui — e
 * o jeito de errar e silencioso: valor cem vezes maior, data no dia errado,
 * venda sem origem porque o `sck` estava num bloco que ninguem leu.
 */
console.log("\n== formato da Utmify, campo por campo ==");

const pedidoU = "UTM-" + Date.now();
const rU = await fetch(`${BASE}/api/pedidos`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-token": parceiro.webhook_secret },
  body: JSON.stringify({
    orderId: pedidoU,
    platform: "MinhaPlataforma",
    paymentMethod: "pix",
    status: "paid",
    createdAt: "2026-08-20 10:00:00",
    approvedDate: "2026-08-20 23:30:00",
    refundedAt: null,
    customer: {
      name: "Ana Nogueira",
      email: "ana@exemplo.com.br",
      phone: "5531988776655",
      document: "12345678909",
      country: "BR",
      ip: "200.100.50.25",
    },
    products: [
      { id: "P1", name: "Kit", planId: null, planName: "Mensal",
        quantity: 2, priceInCents: 4995 },
    ],
    trackingParameters: {
      src: null, sck: click,
      utm_source: "facebook", utm_campaign: "utmify-compat",
      utm_medium: null, utm_content: null, utm_term: null,
    },
    commission: {
      totalPriceInCents: 9990,
      gatewayFeeInCents: 499,
      userCommissionInCents: 9491,
      currency: "BRL",
    },
  }),
});
eq("x-api-token e aceito", rU.status, 200);

const [vU] = await sql`SELECT * FROM orders WHERE gateway_order_id = ${pedidoU}`;
eq("venda registrada", !!vU, true);
/* priceInCents e totalPriceInCents JA sao centavos: multiplicar por cem aqui
   daria R$ 999,00 numa venda de R$ 99,90. */
eq("totalPriceInCents entra como centavo", Number(vU?.gross_cents), 9990);
eq("gatewayFeeInCents vira a taxa", Number(vU?.fee_cents), 499);
eq("metodo pix", vU?.payment_method, "pix");
eq("moeda do bloco commission", vU?.currency, "BRL");

/*
 * A data. "2026-08-20 23:30:00" e UTC na documentacao deles, e o `new Date` do
 * JavaScript leria como hora local — num servidor em Sao Paulo, 23:30 UTC do
 * dia 20 viraria 20:30 do dia 20, e toda venda da noite cairia no dia errado.
 */
eq("data sem fuso e lida como UTC",
  new Date(vU?.occurred_at).toISOString(), "2026-08-20T23:30:00.000Z");

/* O `sck` deles e por onde o nosso clickId volta. */
eq("sck do trackingParameters atribui a venda", vU?.attribution_method, "click_id");
eq("na sessao certa", vU?.click_id, click);

const itensU = await sql`SELECT * FROM order_items WHERE order_id = ${vU?.id}`;
eq("um item", itensU.length, 1);
eq("preco do item em centavos", Number(itensU[0]?.unit_price_cents), 4995);
eq("planName virou a variacao", itensU[0]?.variant, "Mensal");

console.log("\n== isTest valida e nao grava ==");

const pedidoT = "TESTE-" + Date.now();
const rT = await fetch(`${BASE}/api/pedidos`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-token": parceiro.webhook_secret },
  body: JSON.stringify({
    orderId: pedidoT, status: "paid", paymentMethod: "pix",
    isTest: true,
    commission: { totalPriceInCents: 12345, currency: "BRL" },
  }),
});
const jT = await rT.json();
eq("isTest responde 200", rT.status, 200);
eq("e diz que nao gravou", jT.gravado, false);
/* Devolve o que ENTENDEU: e assim que o desenvolvedor ve o valor lido errado
   antes de ligar de verdade, em vez de descobrir pelo faturamento. */
eq("devolve o valor que entendeu", jT.entendido?.valorCents, 12345);

const [naoGravou] = await sql`SELECT id FROM orders WHERE gateway_order_id = ${pedidoT}`;
eq("e nao gravou mesmo", naoGravou, undefined);


console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
process.exit(f === 0 ? 0 : 1);
