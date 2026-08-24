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

console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
process.exit(f === 0 ? 0 : 1);
