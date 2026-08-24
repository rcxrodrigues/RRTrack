/*
 * A fila de reenvio.
 *
 * Antes disto, disparo que falhava ficava falhado para sempre: o token caía por
 * uma hora, a plataforma dava 500 num pico, e aquelas conversões sumiam. Perda
 * direta, e contra o objetivo central do sistema.
 *
 * O que precisa ficar provado é a distinção entre os dois tipos de falha:
 * transitória volta para a fila, recusa de payload não. Insistir num payload
 * que a plataforma nunca vai aceitar só gasta cota que faria falta ao que tem
 * conserto — e é assim que se leva bloqueio.
 *
 * Compilar antes:
 *   npx tsc src/core/dispatch.ts --outDir _tmp --target ES2022 \
 *     --module commonjs --moduleResolution node --skipLibCheck --esModuleInterop --strict
 *   echo {"type":"commonjs"} > _tmp/package.json
 *   node scripts/teste-reenvio.cjs
 */
const { neon } = require("@neondatabase/serverless");
const { webcrypto: wc } = require("node:crypto");
process.loadEnvFile(".env");
const sql = neon(process.env.DATABASE_URL);

let f = 0;
const eq = (l, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  if (!ok) f++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${l}` + (ok ? "" : `  obtido ${JSON.stringify(g)}, esperado ${JSON.stringify(w)}`));
};

/* Só as chamadas ao graph são simuladas; o driver do banco precisa do fetch real. */
const fetchReal = globalThis.fetch;
let resposta = null;
let chamadas = 0;

globalThis.fetch = async (url, init) => {
  if (!String(url).includes("graph.facebook.com")) return fetchReal(url, init);
  chamadas++;
  return resposta;
};

const { reenviarPendentes } = require("../_tmp/core/dispatch.js");

async function cifra(v) {
  const bytes = Uint8Array.from(atob(process.env.CREDENTIALS_KEY), (ch) => ch.charCodeAt(0));
  const k = await wc.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt"]);
  const iv = wc.getRandomValues(new Uint8Array(12));
  const out = await wc.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(v));
  const b = (x) => Buffer.from(x).toString("base64");
  return `${b(iv)}.${b(new Uint8Array(out))}`;
}

(async () => {
  await sql`DELETE FROM tenants WHERE slug = 'reenvio-teste'`;
  const [t] = await sql`INSERT INTO tenants (name, slug) VALUES ('R', 'reenvio-teste') RETURNING id`;
  const cred = JSON.stringify({ accessToken: await cifra("tok") });
  const [dest] = await sql`INSERT INTO destinations (tenant_id, platform, label, external_id, credentials)
    VALUES (${t.id}, 'meta', 'Pixel', '999', ${cred}::jsonb) RETURNING id`;

  /* Payload plausível, com carimbo de agora para caber na janela de 7 dias. */
  const corpo = (segundos) => JSON.stringify({
    data: [{ event_name: "Purchase", event_time: segundos, event_id: "e" + segundos, user_data: {} }],
  });

  const criar = async (estado, proxima, tentativas, quando) => {
    const [d] = await sql`INSERT INTO dispatches
      (tenant_id, destination_id, event_name, event_id, status, attempts, next_attempt_at, request_body, error)
      VALUES (${t.id}, ${dest.id}, 'purchase', ${"ev" + wc.randomUUID()}, ${estado}, ${tentativas},
        ${proxima}, ${corpo(quando ?? Math.floor(Date.now() / 1000))}::jsonb, 'erro anterior')
      RETURNING id`;
    return d.id;
  };

  const passado = new Date(Date.now() - 60_000);
  const futuro = new Date(Date.now() + 600_000);

  console.log("\n== só pega o que está na hora ==");
  const naHora = await criar("failed", passado, 1);
  const cedo = await criar("failed", futuro, 1);
  const semFila = await criar("failed", null, 1);
  const entregue = await criar("sent", null, 1);

  resposta = { ok: true, status: 200, json: async () => ({ events_received: 1 }) };
  chamadas = 0;
  let r = await reenviarPendentes(t.id);

  eq("tentou só um", r.tentados, 1);
  eq("uma chamada à Meta", chamadas, 1);
  eq("entregue", r.entregues, 1);

  const est = async (id) => (await sql`SELECT status, attempts, next_attempt_at, error FROM dispatches WHERE id = ${id}`)[0];
  eq("virou entregue", (await est(naHora)).status, "sent");
  eq("erro limpo", (await est(naHora)).error, null);
  eq("saiu da fila", (await est(naHora)).next_attempt_at, null);
  eq("o agendado para depois ficou parado", (await est(cedo)).status, "failed");
  eq("o sem fila ficou parado", (await est(semFila)).attempts, 1);
  eq("o já entregue não foi tocado", (await est(entregue)).status, "sent");

  console.log("\n== falha transitória volta para a fila ==");
  const transitorio = await criar("failed", passado, 1);
  resposta = { ok: false, status: 503, json: async () => ({}) };
  r = await reenviarPendentes(t.id);
  eq("ainda falhando", r.aindaFalhando, 1);
  eq("não desistiu", r.desistidos, 0);
  const dt = await est(transitorio);
  eq("tentativas subiram", dt.attempts, 2);
  eq("reagendado", dt.next_attempt_at !== null, true);
  eq("espera cresceu além de 1 min", new Date(dt.next_attempt_at).getTime() - Date.now() > 3 * 60_000, true);

  console.log("\n== recusa de payload NÃO volta ==");
  const recusado = await criar("failed", passado, 1);
  resposta = { ok: false, status: 400, json: async () => ({ error: { message: "Invalid parameter" } }) };
  r = await reenviarPendentes(t.id);
  eq("desistiu na hora", r.desistidos, 1);
  eq("fora da fila", (await est(recusado)).next_attempt_at, null);

  console.log("\n== desiste depois de esgotar as tentativas ==");
  const cansado = await criar("failed", passado, 5);
  resposta = { ok: false, status: 503, json: async () => ({}) };
  r = await reenviarPendentes(t.id);
  eq("desistiu", r.desistidos, 1);
  eq("não reagendou", (await est(cansado)).next_attempt_at, null);

  console.log("\n== evento velho não é reenviado ==");
  const velho = await criar("failed", passado, 1, Math.floor(Date.now() / 1000) - 9 * 86400);
  chamadas = 0;
  r = await reenviarPendentes(t.id);
  eq("nem chamou a Meta", chamadas, 0);
  eq("desistiu", r.desistidos, 1);
  eq("motivo é a janela", (await est(velho)).error.includes("7 dias"), true);

  console.log("\n== destino desativado ==");
  const orfao = await criar("failed", passado, 1);
  await sql`UPDATE destinations SET active = false WHERE id = ${dest.id}`;
  chamadas = 0;
  r = await reenviarPendentes(t.id);
  eq("não chamou", chamadas, 0);
  eq("desistiu", r.desistidos, 1);
  eq("motivo explícito", (await est(orfao)).error.includes("inativo"), true);

  console.log("\n== nada pendente não custa nada ==");
  await sql`UPDATE dispatches SET next_attempt_at = null WHERE tenant_id = ${t.id}`;
  chamadas = 0;
  r = await reenviarPendentes(t.id);
  eq("zero tentativas", r.tentados, 0);
  eq("zero chamadas", chamadas, 0);

  await sql`DELETE FROM tenants WHERE slug = 'reenvio-teste'`;
  console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
  process.exit(f === 0 ? 0 : 1);
})();
