/*
 * As proteções contra levar bloqueio da plataforma.
 *
 * Três formas diferentes de estourar limite, e uma porta para cada:
 *
 *   busca simultânea      duas abas abertas virariam duas buscas paralelas
 *   insistência           clicar "Atualizar" dez vezes aproxima o bloqueio
 *   ignorar o aviso       a Meta diz quanto da cota foi usada; voar às cegas
 *                         é como se descobre que estourou
 *
 * A API é simulada. O que precisa ficar provado não é falar com a Meta — é
 * NÃO falar quando não se deve.
 *
 * Compilar antes:
 *   npx tsc src/core/sincronizar-gasto.ts src/ads/meta.ts --outDir _tmp \
 *     --target ES2022 --module commonjs --moduleResolution node \
 *     --skipLibCheck --esModuleInterop --strict
 *   echo {"type":"commonjs"} > _tmp/package.json
 *   node scripts/teste-limites.cjs
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

let chamadas = 0;
let cabecalho = null;
let respostaOk = true;

/*
 * Intercepta SÓ as chamadas à Meta. O driver da Neon também usa fetch, então
 * substituir tudo derrubaria as consultas ao banco antes de qualquer teste.
 */
const fetchReal = globalThis.fetch;

globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.includes("graph.facebook.com")) return fetchReal(url, init);

  chamadas++;
  if (u.includes("fields=currency")) {
    return { ok: true, json: async () => ({ currency: "BRL" }), headers: { get: () => null } };
  }
  return {
    ok: respostaOk,
    status: respostaOk ? 200 : 400,
    text: async () => '{"error":{"code":80000}}',
    json: async () => ({ data: [] }),
    headers: { get: (h) => (h === "x-business-use-case-usage" ? cabecalho : null) },
  };
};

const { sincronizarGasto } = require("../_tmp/core/sincronizar-gasto.js");

async function cifra(v) {
  const bytes = Uint8Array.from(atob(process.env.CREDENTIALS_KEY), (ch) => ch.charCodeAt(0));
  const k = await wc.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt"]);
  const iv = wc.getRandomValues(new Uint8Array(12));
  const out = await wc.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(v));
  const b = (x) => Buffer.from(x).toString("base64");
  return `${b(iv)}.${b(new Uint8Array(out))}`;
}

(async () => {
  await sql`DELETE FROM tenants WHERE slug = 'limite-teste'`;
  const [t] = await sql`INSERT INTO tenants (name, slug) VALUES ('L', 'limite-teste') RETURNING id`;
  const [c] = await sql`INSERT INTO ad_accounts (tenant_id, platform, external_id, label, credentials)
    VALUES (${t.id}, 'meta', 'act_1', 'Conta', '{}'::jsonb) RETURNING id`;

  const cred = JSON.stringify({ accessToken: await cifra("tok") });
  await sql`UPDATE ad_accounts SET credentials = ${cred}::jsonb WHERE id = ${c.id}`;

  const zera = (extra) => sql`UPDATE ad_accounts SET syncing_since = null, blocked_until = null,
    last_synced_at = now() - interval '1 hour' WHERE id = ${c.id}`;

  console.log("\n== recua sozinho a 80% da cota ==");
  cabecalho = JSON.stringify({ "123": [{ call_count: 85, total_time: 10, total_cputime: 5 }] });
  chamadas = 0;
  let r = await sincronizarGasto(t.id, { dias: 1 });
  eq("avisou que parou antes de estourar", r[0].avisos.some((a) => a.includes("cota")), true);
  const [d1] = await sql`SELECT usage_pct, syncing_since FROM ad_accounts WHERE id = ${c.id}`;
  eq("guardou o uso lido do cabeçalho", Math.round(d1.usage_pct), 85);
  eq("soltou a trava ao terminar", d1.syncing_since, null);

  console.log("\n== intervalo mínimo entre buscas ==");
  chamadas = 0;
  r = await sincronizarGasto(t.id, { dias: 1 });
  eq("pulou sem chamar a API", chamadas, 0);
  eq("disse o motivo", r[0].pulou.includes("menos de um minuto"), true);

  console.log("\n== forçar ignora só o intervalo ==");
  chamadas = 0;
  r = await sincronizarGasto(t.id, { dias: 1, forcar: true });
  eq("chamou a API", chamadas > 0, true);

  console.log("\n== bloqueio da plataforma é respeitado ==");
  await sql`UPDATE ad_accounts SET blocked_until = now() + interval '20 minutes',
    syncing_since = null, last_synced_at = now() - interval '1 hour' WHERE id = ${c.id}`;
  chamadas = 0;
  r = await sincronizarGasto(t.id, { dias: 1, forcar: true });
  eq("NÃO chamou, mesmo forçando", chamadas, 0);
  eq("disse quanto falta", r[0].pulou.includes("libera em"), true);

  console.log("\n== trava contra busca simultânea ==");
  await zera();
  await sql`UPDATE ad_accounts SET syncing_since = now() WHERE id = ${c.id}`;
  chamadas = 0;
  r = await sincronizarGasto(t.id, { dias: 1, forcar: true });
  eq("NÃO chamou", chamadas, 0);
  eq("disse que já há uma correndo", r[0].pulou.includes("em andamento"), true);

  console.log("\n== trava presa destrava sozinha ==");
  await sql`UPDATE ad_accounts SET syncing_since = now() - interval '10 minutes' WHERE id = ${c.id}`;
  chamadas = 0;
  r = await sincronizarGasto(t.id, { dias: 1, forcar: true });
  eq("voltou a chamar depois de 5 min", chamadas > 0, true);

  console.log("\n== erro de limite vira bloqueio guardado ==");
  cabecalho = null;
  respostaOk = false;
  await zera();
  r = await sincronizarGasto(t.id, { dias: 1, forcar: true });
  eq("avisou do limite", r[0].avisos.some((a) => a.includes("limite da Meta")), true);
  const [d2] = await sql`SELECT blocked_until, syncing_since FROM ad_accounts WHERE id = ${c.id}`;
  eq("guardou o bloqueio", d2.blocked_until !== null, true);
  eq("soltou a trava mesmo em erro", d2.syncing_since, null);

  console.log("\n== e a partir daí respeita o próprio bloqueio ==");
  chamadas = 0;
  r = await sincronizarGasto(t.id, { dias: 1, forcar: true });
  eq("não tenta de novo", chamadas, 0);

  await sql`DELETE FROM tenants WHERE slug = 'limite-teste'`;
  console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
  process.exit(f === 0 ? 0 : 1);
})();
