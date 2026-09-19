/*
 * O isolamento entre lojas, conferido no código.
 *
 * Roda pela suíte: `node scripts/testar.mjs`.
 *
 * A REGRA 1 diz que toda tabela de negócio carrega `tenantId` e que consulta
 * sem `where tenantId` é vazamento entre clientes. Só que a regra vale até
 * alguém esquecer — e esquecer não dá erro: a consulta funciona, devolve
 * linhas, e as linhas são de outra loja. Ninguém vê nada até um cliente ver o
 * dado de outro.
 *
 * O PLANO ERA RLS no banco, e ele continua de pé — mas RLS não é o que este
 * arquivo faz, e é importante não confundir os dois:
 *
 *   RLS proteje em TEMPO DE EXECUÇÃO: o banco recusa a linha mesmo que o
 *   código peça. É mais forte, e custa caro aqui (ver o cabeçalho de
 *   src/db/index.ts: o driver HTTP do Neon não mantém conexão entre
 *   statements, então `SET LOCAL` não cola e `db.transaction()` nem existe).
 *
 *   ISTO proteje em TEMPO DE COMMIT: nenhuma consulta nova chega ao banco sem
 *   um escopo reconhecido. Mais fraco, e de graça.
 *
 * O QUE ISTO PROVA, exatamente: que toda consulta a tabela de negócio se
 * encaixa num de três padrões seguros. O que NÃO prova: que acesso cruzado
 * entre lojas é impossível — o padrão "age pela chave primária" é seguro
 * porque o id só se obtém de uma leitura já filtrada por tenant, e disso aqui
 * não há prova, é leitura de quem escreveu. Guarda que promete mais do que
 * confere é pior que guarda nenhuma.
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

let f = 0;
const eq = (l, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) f++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${l}` + (ok ? "" : `\n         obtido:   ${JSON.stringify(g)}\n         esperado: ${JSON.stringify(w)}`)); };

const ler = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

/* ------------------------------------------- quais tabelas têm dono -- */

const schema = ler("src/db/schema.ts");
const comTenant = new Set();
for (const m of schema.matchAll(/export const (\w+) = pgTable\("(\w+)",([\s\S]*?)\n\}\)?,?\s*(?:\(t\)|;)/g)) {
  if (m[3].includes("tenant_id")) comTenant.add(m[1]);
}

console.log("\n== as tabelas de negócio ==");
eq("o schema tem tabelas com tenant_id", comTenant.size > 10, true);
/* Se uma tabela de negócio perder o tenant_id, ela some deste conjunto e as
   consultas a ela deixam de ser conferidas — em silêncio. */
for (const t of ["orders", "events", "clickSessions", "dispatches", "destinations", "adAccounts"]) {
  eq(`${t} carrega tenantId`, comTenant.has(t), true);
}
/* A exceção declarada: contador de contenção conta quem chega ANTES de se
   saber de que loja é a chamada. Ver o comentário no schema. */
eq("rate_limits é a exceção, e está fora", comTenant.has("rateLimits"), false);

/* --------------------------------------------- toda consulta, uma a uma -- */

/*
 * Três padrões são aceitos, e cada um por um motivo diferente:
 *
 *   TENANT — filtra por `tenantId`. O caso normal.
 *
 *   CHAVE PRIMÁRIA — age por `id`. O id é UUID e só se obtém de uma leitura
 *   anterior; quem não tem o id de uma linha não a alcança. É o padrão
 *   "lê filtrado, age pelo id" que a maior parte do código usa.
 *
 *   COLUNA ÚNICA GLOBAL — busca por `public_key`, `webhook_secret`, `secret`,
 *   `clickId` ou `domain`. São as buscas que DESCOBREM a loja: o coletor e o
 *   webhook não podem filtrar por tenant porque o tenant é o que eles querem
 *   saber. Só valem porque o banco garante unicidade — ver a asserção no fim.
 */
const UNICAS = ["publicKey", "webhookSecret", "secret", "clickId", "domain"];

const arquivos = execSync(
  `grep -rlE "\\bdb\\.(select|insert|update|delete)\\(" app src --include=*.ts --include=*.tsx`,
  { encoding: "utf8", cwd: new URL("..", import.meta.url) },
).trim().split("\n");

const conta = { tenant: 0, porId: 0, porUnica: 0 };
const semEscopo = [];

for (const arq of arquivos) {
  const src = ler(arq);
  for (const m of src.matchAll(/\bdb\.(select|insert|update|delete)\(/g)) {
    const i = m.index;
    /* O comando vai do `db.X(` até o `;` fora de parênteses. */
    let j = i, prof = 0, fim = -1;
    while (j < src.length) {
      const c = src[j];
      if (c === "(") prof++;
      else if (c === ")") prof--;
      else if (c === ";" && prof === 0) { fim = j; break; }
      j++;
    }
    const trecho = src.slice(i, fim < 0 ? i + 400 : fim);
    const tabelas = [...trecho.matchAll(/(?:from|into|update|delete)\(\s*(\w+)/g)].map((x) => x[1]);
    if (!tabelas.some((t) => comTenant.has(t))) continue;

    if (/tenantId|tenant_id/.test(trecho)) { conta.tenant++; continue; }
    if (/eq\(\s*\w+\.id\s*,/.test(trecho)) { conta.porId++; continue; }
    if (UNICAS.some((u) => new RegExp(`eq\\(\\s*\\w+\\.${u}\\s*,`).test(trecho))) {
      conta.porUnica++; continue;
    }
    semEscopo.push(`${arq}:${src.slice(0, i).split("\n").length} — ${trecho.slice(0, 80).replace(/\s+/g, " ")}`);
  }
}

const total = conta.tenant + conta.porId + conta.porUnica + semEscopo.length;

console.log("\n== toda consulta a tabela de negócio tem escopo ==");
console.log(`         | ${total} consultas: ${conta.tenant} por tenantId,`
  + ` ${conta.porId} por chave primária, ${conta.porUnica} por coluna única`);

eq("a varredura encontrou consultas", total > 50, true);
/*
 * ESTA É A ASSERÇÃO. Uma consulta nova que não se encaixe em nenhum dos três
 * padrões reprova a suíte — e o conserto é acrescentar o filtro, não
 * acrescentar o caso aqui. Se for exceção legítima (como as buscas que
 * DESCOBREM a loja), ela entra em UNICAS com o índice único correspondente.
 */
eq("nenhuma sem escopo reconhecido", semEscopo, []);

/* ------------------------------- e as colunas únicas são únicas MESMO -- */

console.log("\n== as chaves que descobrem a loja são únicas no banco ==");
/*
 * O padrão "busca por coluna única global" só é seguro se o BANCO garantir a
 * unicidade. Sem índice único, duas linhas podem repetir o valor e o
 * `limit(1)` escolhe uma — o beacon entra na loja errada, a VENDA entra na
 * loja errada, e nada dá erro.
 *
 * Não era colisão aleatória que preocupava (são 96 bits). Era não haver nada
 * impedindo: `regerar_chave` não confere, uma restauração pode repetir, e
 * clonar a configuração de uma oferta para outra — que é o plano — copiaria a
 * chave junto.
 */
for (const [rotulo, indice] of [
  ["sites.public_key", "sites_public_key"],
  ["sites.domain", "sites_domain"],
  ["gateway_connections.webhook_secret", "gateway_conn_secret"],
  ["meta_links.secret", "meta_links_secret"],
  ["click_sessions.click_id", null],
]) {
  if (indice) {
    eq(`${rotulo} tem índice único`,
      new RegExp(`uniqueIndex\\("${indice}"\\)`).test(schema), true);
  } else {
    /* clickId é a chave primária de click_sessions — único por definição. */
    eq(`${rotulo} é chave primária`,
      /clickId: uuid\("click_id"\)\.primaryKey\(\)/.test(schema), true);
  }
}

console.log("\n== e a busca por chave única não escolhe no escuro ==");
/*
 * `limit(1)` sem `orderBy` numa busca que pode devolver duas linhas escolhe
 * qualquer uma — foi assim que o painel leu um site e a verificação do coletor
 * gravou noutro. Com o índice único acima isso deixa de ser possível para
 * estas colunas; a asserção existe para que a remoção do índice apareça aqui,
 * e não em produção.
 */
eq("o coletor busca a loja pela chave pública",
  /eq\(sites\.publicKey, siteKey\)/.test(ler("app/api/collect/route.ts")), true);
eq("e o webhook pela conexão",
  /eq\(gatewayConnections\.webhookSecret, secret\)/.test(ler("src/core/receber.ts")), true);

console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
process.exit(f === 0 ? 0 : 1);
