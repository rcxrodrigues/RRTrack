/*
 * Roda a suíte inteira.
 *
 * Existe porque metade dos testes precisa dos módulos de `src/core` compilados
 * para CommonJS antes de rodar — a lista de quais é fácil de esquecer, e
 * esquecer não dá erro: os testes simplesmente não rodam e a saída fica vazia,
 * que é indistinguível de "passou" para quem está com pressa.
 *
 *   node scripts/testar.mjs            contra o banco e a produção
 *   RR_BASE=http://localhost:3000 ...  contra o servidor local
 */
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";

const BASE = process.env.RR_BASE ?? "https://rr-track.vercel.app";

/* Os que precisam de compilação, com o módulo que cada um exige. */
const COMPILAR = [
  "src/core/resumo.ts", "src/core/rastreio.ts", "src/core/custos.ts",
  "src/core/metricas.ts", "src/core/reconciliacao.ts", "src/core/dispatch.ts",
  "src/core/sincronizar-gasto.ts",
  "src/gateways/appmax.ts", "src/gateways/pagou.ts", "src/gateways/generico.ts",
  "src/destinations/google.ts", "src/destinations/tiktok.ts",
  "src/ads/google.ts", "src/ads/tiktok.ts",
];

/* Unitários: falam com o banco e com APIs simuladas, nunca com a rede real. */
const UNITARIOS = [
  "metricas", "resumo", "limites", "custos",
  "confirmacao", "tiktok", "google", "reenvio", "reconciliacao", "generico",
];

/* De ponta a ponta: batem no servidor de verdade, e precisam de uma semente. */
const PONTA = ["e2e", "gateways", "eventos", "enriquecimento"];

console.log(`compilando ${COMPILAR.length} módulos...`);
rmSync("_tmp", { recursive: true, force: true });
execFileSync("npx", [
  "tsc", ...COMPILAR,
  "--outDir", "_tmp", "--target", "ES2022", "--module", "commonjs",
  "--moduleResolution", "node", "--skipLibCheck", "--esModuleInterop", "--strict",
], { stdio: "inherit", shell: true });
writeFileSync("_tmp/package.json", '{"type":"commonjs"}');

let falhas = 0;

/*
 * Sem shell, de proposito. A semente e um JSON que vai por argumento, e passar
 * isso por linha de comando no Windows o entrega mutilado: as aspas somem e o
 * teste morre em JSON.parse antes de rodar a primeira asserção.
 */
const rodar = (nome, args) => {
  let saida = "";
  let ok = true;
  try {
    saida = execFileSync("node", args, {
      encoding: "utf8",
      env: { ...process.env, RR_BASE: BASE },
    });
  } catch (e) {
    saida = (e.stdout ?? "") + (e.stderr ?? "");
    ok = false;
  }
  /* A última linha não vazia é o veredito que cada teste imprime. */
  const linhas = saida.trim().split("\n").filter((l) => l.trim());
  const veredito = linhas[linhas.length - 1] ?? "(sem saída)";
  if (!ok || !veredito.includes("PASSARAM")) {
    falhas++;
    console.log(`\n  FALHA | ${nome}\n${saida.split("\n").filter((l) => l.includes("FALHA")).join("\n")}`);
  }
  console.log(`  ${ok && veredito.includes("PASSARAM") ? "ok  " : "FALHA"} | ${nome.padEnd(16)} ${veredito}`);
};

console.log("\n== unitários ==");
for (const t of UNITARIOS) rodar(t, [`scripts/teste-${t}.cjs`]);

console.log(`\n== ponta a ponta contra ${BASE} ==`);
for (const t of PONTA) {
  const semente = execFileSync("node", ["scripts/seed.mjs"], { encoding: "utf8" });
  /* Compacta: o teste so precisa do objeto, e uma linha so viaja inteira. */
  rodar(t, [`scripts/teste-${t}.mjs`, JSON.stringify(JSON.parse(semente))]);
}

rmSync("_tmp", { recursive: true, force: true });
console.log(`\n${falhas === 0 ? "SUÍTE INTEIRA PASSOU" : falhas + " SUÍTE(S) COM FALHA"}\n`);
process.exit(falhas === 0 ? 0 : 1);
