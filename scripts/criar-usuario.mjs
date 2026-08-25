/*
 * Cria uma pessoa e a dá acesso a lojas.
 *
 * Existe porque não há tela de convite ainda — e porque a primeira conta de
 * qualquer sistema tem que nascer fora dele. Quando houver convite por e-mail,
 * esta lógica vira o aceite do convite.
 *
 *   node scripts/criar-usuario.mjs --email voce@exemplo.com --nome "Seu Nome"
 *
 * A senha é perguntada e não aparece enquanto se digita. Passá-la por --senha
 * ainda funciona, para automação, mas deixa rastro — ver perguntarSenha().
 *
 * Sem --loja, dá acesso a TODAS as lojas existentes (o caso de quem é dono de
 * tudo). Rodar de novo com o mesmo e-mail troca a senha e refaz os acessos.
 */

import { neon } from "@neondatabase/serverless";
import { webcrypto as wc } from "node:crypto";
import { createInterface } from "node:readline";

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

/*
 * Pergunta a senha sem mostrar o que está sendo digitado.
 *
 * Senha em linha de comando vaza por três caminhos ao mesmo tempo: fica no
 * histórico do shell, aparece na lista de processos enquanto o comando roda, e
 * sobra em qualquer transcrição da sessão. Perguntar aqui elimina os três.
 */
async function perguntarSenha() {
  /*
   * Sem terminal não há como perguntar nada. Acontece em CI, em `| cat` e em
   * qualquer chamada com a entrada redirecionada — e sem este aviso o erro
   * seria uma pilha de stack trace que não diz o que fazer.
   */
  if (!process.stdin.isTTY) {
    console.error(
      "\nErro: não há terminal para perguntar a senha.\n" +
      "Rode direto no terminal, ou passe --senha se for automação.\n",
    );
    process.exit(1);
  }

  const rl = createInterface({
    input: process.stdin, output: process.stdout, terminal: true,
  });

  const pedir = (rotulo) => new Promise((resolve) => {
    process.stdout.write(rotulo);
    /*
     * O `write` do readline é chamado a cada tecla. Trocá-lo por uma função
     * vazia é o que impede a senha — e até o tamanho dela — de aparecer.
     */
    const original = rl.output.write.bind(rl.output);
    rl.output.write = () => {};
    rl.question("", (valor) => {
      rl.output.write = original;
      process.stdout.write("\n");
      resolve(valor);
    });
  });

  const primeira = await pedir("Senha (não aparece enquanto digita): ");
  const segunda = await pedir("Digite de novo para confirmar: ");
  rl.close();

  if (primeira !== segunda) {
    console.error("\nAs duas não bateram. Rode o comando de novo.\n");
    process.exit(1);
  }
  return primeira;
}

const a = args(process.argv.slice(2));

const email = (a.email ?? "").trim().toLowerCase();
const nome = a.nome ?? null;

if (!email || !email.includes("@")) {
  console.error("\nErro: --email é obrigatório\n");
  process.exit(1);
}

if (a.senha) {
  console.warn(
    "\nAviso: senha passada por argumento fica no histórico do shell e na\n" +
    "lista de processos. Rode sem --senha para que ela seja perguntada.\n",
  );
}

const senha = a.senha ?? await perguntarSenha();

/*
 * Doze caracteres é o piso, não a recomendação. Senha curta em painel que
 * guarda token de API é o elo fraco de todo o resto — a cifragem das
 * credenciais no banco não vale nada se a porta da frente abre no chute.
 */
if (senha.length < 12) {
  console.error(
    `\nErro: a senha precisa de pelo menos 12 caracteres (esta tem ${senha.length}).\n` +
    "Quatro palavras aleatórias passam com folga e são fáceis de lembrar.\n",
  );
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
