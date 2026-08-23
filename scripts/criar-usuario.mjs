/*
 * Cria uma pessoa e a dá acesso a lojas.
 *
 * Existe porque não há tela de convite ainda — e porque a primeira conta de
 * qualquer sistema tem que nascer fora dele. Quando houver convite por e-mail,
 * esta lógica vira o aceite do convite.
 *
 *   node scripts/criar-usuario.mjs --email voce@exemplo.com --nome "Seu Nome" \
 *     --senha "uma senha longa" --loja loja-teste --loja outra-loja
 *
 * Sem --loja, dá acesso a TODAS as lojas existentes (o caso de quem é dono de
 * tudo). Rodar de novo com o mesmo e-mail troca a senha e refaz os acessos.
 */

import { neon } from "@neondatabase/serverless";
import { webcrypto as wc } from "node:crypto";

process.loadEnvFile(".env");
const sql = neon(process.env.DATABASE_URL);

/* Mesmo formato do src/core/auth.ts: "iteracoes.sal.hash" em base64. */
const ITERACOES = 210_000;
const b64 = (b) => Buffer.from(b).toString("base64");

async function hashSenha(senha) {
  const sal = wc.getRandomValues(new Uint8Array(16));
  const material = await wc.subtle.importKey("raw", new TextEncoder().encode(senha), "PBKDF2", false, ["deriveBits"]);
  const bits = await wc.subtle.deriveBits(
    { name: "PBKDF2", salt: sal, iterations: ITERACOES, hash: "SHA-256" },
    material, 256,
  );
  return `${ITERACOES}.${b64(sal)}.${b64(new Uint8Array(bits))}`;
}

function args(argv) {
  const out = { loja: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    if (k === "loja") out.loja.push(v);
    else out[k] = v;
  }
  return out;
}

const a = args(process.argv.slice(2));

const email = (a.email ?? "").trim().toLowerCase();
const senha = a.senha ?? "";
const nome = a.nome ?? null;

if (!email || !email.includes("@")) {
  console.error("\nErro: --email é obrigatório\n");
  process.exit(1);
}

/*
 * Doze caracteres é o piso, não a recomendação. Senha curta em painel que
 * guarda token de API é o elo fraco de todo o resto — a cifragem das
 * credenciais no banco não vale nada se a porta da frente abre no chute.
 */
if (senha.length < 12) {
  console.error("\nErro: --senha precisa de pelo menos 12 caracteres\n");
  process.exit(1);
}

const hash = await hashSenha(senha);

const [existente] = await sql`SELECT id FROM users WHERE email = ${email}`;
let userId;

if (existente) {
  userId = existente.id;
  await sql`UPDATE users SET password_hash = ${hash}, name = COALESCE(${nome}, name) WHERE id = ${userId}`;
  /* Trocar a senha derruba as sessões abertas — é o que se espera de uma troca. */
  await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
  console.log(`\nUsuário já existia. Senha trocada e sessões encerradas.`);
} else {
  const [u] = await sql`
    INSERT INTO users (email, name, password_hash) VALUES (${email}, ${nome}, ${hash})
    RETURNING id`;
  userId = u.id;
  console.log(`\nUsuário criado.`);
}

const lojas = a.loja.length
  ? await sql`SELECT id, name, slug FROM tenants WHERE slug = ANY(${a.loja})`
  : await sql`SELECT id, name, slug FROM tenants ORDER BY created_at`;

if (lojas.length === 0) {
  console.log("\nNenhuma loja encontrada — cadastre uma com scripts/cadastrar.mjs.\n");
  process.exit(0);
}

for (const l of lojas) {
  await sql`
    INSERT INTO memberships (tenant_id, user_id, role)
    VALUES (${l.id}, ${userId}, 'owner')
    ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = 'owner'`;
}

console.log(`\n  ${email}`);
console.log(`  acesso a ${lojas.length} loja(s):`);
for (const l of lojas) console.log(`    · ${l.name} (${l.slug})`);
console.log(`\n  Entre em ${process.env.RR_BASE || "https://rr-track.vercel.app"}/entrar\n`);
