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
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/*
 * O piso de versão do Node, conferido antes de tudo.
 *
 * `process.loadEnvFile` chegou no Node 20.12 — este arquivo e mais dezenove
 * scripts dependem dela. Abaixo disso a suíte morre com
 * "process.loadEnvFile is not a function", mensagem que não diz o que fazer e
 * que só aparece DEPOIS de o clone e o `npm install` terem dado certo.
 *
 * É o primeiro tropeço de quem restaura numa máquina nova, e o mais confuso:
 * tudo parecia ter funcionado até ali. O `engines` do package.json declara o
 * mesmo piso, mas o npm só avisa — não impede. Aqui a mensagem chega na hora
 * certa e diz o que resolve.
 */
const NODE_MINIMO = [20, 12];
const versao = process.versions.node.split(".").map(Number);

if (versao[0] < NODE_MINIMO[0]
  || (versao[0] === NODE_MINIMO[0] && versao[1] < NODE_MINIMO[1])) {
  console.error(
    `\nEste projeto precisa do Node ${NODE_MINIMO.join(".")} ou mais novo.`
    + `\nVocê está no ${process.versions.node}.`
    + "\n\nA suíte usa process.loadEnvFile(), que só existe a partir do 20.12."
    + "\nAtualize o Node e rode de novo.\n",
  );
  process.exit(1);
}

/*
 * Contra QUEM os testes de ponta a ponta rodam.
 *
 * O padrão era produção, e isso custou uma tarde. `npm test` num clone novo
 * disparava webhook de verdade no servidor de verdade e semeava lojas de teste
 * no banco de verdade — sem pedir nada a ninguém. Como a semente é cifrada com
 * a CREDENTIALS_KEY LOCAL e a produção decifra com a DELA, todas as defesas de
 * assinatura falharam em cascata e o relatório parecia buraco de segurança em
 * produção. Não era: era o teste escrevendo num lugar que não sabia ler.
 *
 * Agora o padrão é a máquina de quem roda, e sair dela exige dizer que quer:
 * `--remoto`. Não é burocracia — é que mandar evento para produção precisa ser
 * uma decisão, não o que acontece quando ninguém decidiu nada.
 */
const LOCAL = "http://localhost:3000";
const BASE = process.env.RR_BASE ?? LOCAL;
const REMOTO = process.argv.includes("--remoto");

if (!BASE.startsWith("http://localhost") && !BASE.startsWith("http://127.0.0.1") && !REMOTO) {
  console.error(
    `\nRR_BASE aponta para ${BASE}, que não é esta máquina.`
    + "\n\nOs testes de ponta a ponta gravam lojas de teste no banco e disparam"
    + "\nwebhook no endereço alvo. Contra produção isso mexe em dado real."
    + "\n\nSe é isso mesmo que você quer:   npm test -- --remoto"
    + "\nSe não é, tire o RR_BASE do .env e suba o servidor com npm run dev.\n",
  );
  process.exit(1);
}

/* Os que precisam de compilação, com o módulo que cada um exige. */
const COMPILAR = [
  "src/core/resumo.ts", "src/core/rastreio.ts", "src/core/custos.ts",
  "src/core/faixas.ts", "src/core/faturamento.ts", "src/core/taxas.ts",
  "src/core/metricas.ts", "src/core/reconciliacao.ts", "src/core/dispatch.ts",
  "src/core/sincronizar-gasto.ts",
  "src/gateways/appmax.ts", "src/gateways/pagou.ts", "src/gateways/generico.ts",
  "src/gateways/shopify.ts",
  "src/core/janela.ts", "src/core/robos.ts", "src/core/redes.ts", "src/core/normalizar.ts",
  "src/core/utm.ts", "src/core/versoes.ts", "src/core/dominio.ts", "src/ads/meta.ts",
  "src/destinations/google.ts", "src/destinations/tiktok.ts", "src/destinations/ga4.ts",
  "src/ads/google.ts", "src/ads/tiktok.ts",
];

/*
 * Unitários, separados pelo que EXIGEM para rodar.
 *
 * A divisão existe por causa de máquina nova. O `.env` não vem no clone — de
 * propósito, e o RECUPERACAO.md explica por quê — então quem acabou de clonar
 * não tem `DATABASE_URL` nem `CREDENTIALS_KEY` até ir buscar nos painéis. Sem
 * a separação, a suíte inteira morria na primeira linha e não dizia nada sobre
 * um código que talvez estivesse perfeito.
 *
 * Os puros simulam a API e não abrem conexão nenhuma: rodam num clone recém
 * feito, sem segredo nenhum. É o que `--sem-banco` roda.
 */
const UNITARIOS_PUROS = [
  "taxas", "confirmacao", "tiktok", "google", "generico",
  "shopify", "produto-pagina", "normalizar", "janela",
  "robos", "utm", "versoes", "coletor", "ga4", "ads-meta",
];

/* Estes abrem conexão com o Postgres: precisam do `.env` preenchido. */
const UNITARIOS_BANCO = [
  "metricas", "resumo", "faturamento", "limites", "custos",
  "reenvio", "reconciliacao",
];

/*
 * `--sem-banco` roda só o que dispensa credencial.
 *
 * Não substitui a suíte: as agregações do painel, a fila de reenvio e a
 * reconciliação ficam de fora, e são justamente as que mexem em número. Serve
 * para provar que o código compila e que a interpretação está certa enquanto
 * o `.env` não chega.
 */
const SEM_BANCO = process.argv.includes("--sem-banco");

const UNITARIOS = SEM_BANCO
  ? UNITARIOS_PUROS
  : [...UNITARIOS_PUROS, ...UNITARIOS_BANCO];

/*
 * O arquivo de um teste, seja `.cjs` ou `.mjs`.
 *
 * Os dois formatos convivem porque a diferença é de como cada teste foi
 * escrito, não do que ele faz — `teste-ads-meta` usa `await` no topo, que só
 * existe em ESM. Fixar a extensão em `.cjs` foi o que manteve ele e o
 * `teste-utm` fora da suíte: existiam, passavam, e ninguém rodava.
 */
const arquivoDe = (nome) => {
  for (const ext of ["cjs", "mjs"]) {
    const caminho = `scripts/teste-${nome}.${ext}`;
    if (existsSync(caminho)) return caminho;
  }
  throw new Error(`teste "${nome}" não encontrado em scripts/`);
};

/* De ponta a ponta: batem no servidor de verdade, e precisam de uma semente. */
const PONTA = ["e2e", "gateways", "eventos", "enriquecimento", "api-entrada", "taxas-e2e"];

console.log(`compilando ${COMPILAR.length} módulos...`);
rmSync("_tmp", { recursive: true, force: true });
/*
 * Chama o `tsc` local pelo próprio Node, em vez de `npx` com `shell: true`.
 *
 * O shell existia para o Windows, onde `npx` é um `.cmd` que o `execFile` não
 * executa sozinho. Só que shell ligado faz o Node avisar a cada execução
 * (DEP0190): argumento passado por shell é concatenado, não escapado — aqui
 * são nomes de arquivo nossos, mas o aviso é justo e some junto com o shell.
 *
 * O binário do TypeScript é um arquivo .js comum. Rodá-lo com `process.execPath`
 * dispensa shell, dispensa o `npx`, funciona igual nos três sistemas e ainda
 * economiza a resolução que o npx faria toda vez.
 */
/* `fileURLToPath`, e não `.pathname`: no Windows o pathname sai "/C:/...",
   com uma barra a mais que invalida o caminho. */
const TSC = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));

execFileSync(process.execPath, [
  TSC, ...COMPILAR,
  "--outDir", "_tmp", "--target", "ES2022", "--module", "commonjs",
  "--moduleResolution", "node", "--skipLibCheck", "--esModuleInterop", "--strict",
], { stdio: "inherit" });
writeFileSync("_tmp/package.json", '{"type":"commonjs"}');

let falhas = 0;
let infra = 0;

/*
 * Sem shell, de proposito. A semente e um JSON que vai por argumento, e passar
 * isso por linha de comando no Windows o entrega mutilado: as aspas somem e o
 * teste morre em JSON.parse antes de rodar a primeira asserção.
 */
/*
 * Infraestrutura caída NÃO é teste reprovado, e confundir as duas custa tempo.
 *
 * Quando a conexão com o Neon cai no meio da suíte, o driver estoura uma
 * rejeição não tratada: o processo morre com pilha de erro, o orquestrador vê
 * saída diferente de "PASSARAM" e anuncia FALHA. Quem lê presume que quebrou
 * alguma coisa e vai procurar o defeito no código — onde não há nenhum.
 *
 * Aconteceu aqui: 20 testes verdes, o 21º com `UND_ERR_CONNECT_TIMEOUT`, e o
 * relatório dizendo só "FALHA". O `obtido 500` da mesma execução era o servidor
 * de dev sem banco, pela mesma razão — dois sintomas, uma causa, nenhum deles
 * apontando para ela.
 *
 * As assinaturas abaixo são específicas de propósito: nada aqui casa com um
 * teste que reprovou de verdade, então um defeito real continua aparecendo
 * como defeito real.
 */
const SEM_INFRA = [
  "UND_ERR_CONNECT_TIMEOUT",
  "Error connecting to database",
  "ECONNREFUSED",
  "ENOTFOUND",
  "fetch failed",
];

const rodar = (nome, args) => {
  let saida = "";
  let ok = true;
  try {
    saida = execFileSync("node", args, {
      encoding: "utf8",
      env: { ...process.env, RR_BASE: BASE },
      /* Captura o stderr em vez de deixá-lo vazar: o padrão despeja a pilha do
         filho direto no terminal, e vinte linhas de rastreio antes do veredito
         enterram justamente a linha que diz o que houve. O conteúdo não se
         perde — ele entra em `saida` e é o que classifica FALHA de INFRA. */
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    saida = (e.stdout ?? "") + (e.stderr ?? "");
    ok = false;
  }
  /* A última linha não vazia é o veredito que cada teste imprime. */
  const linhas = saida.trim().split("\n").filter((l) => l.trim());
  const veredito = linhas[linhas.length - 1] ?? "(sem saída)";
  const passou = ok && veredito.includes("PASSARAM");

  if (!passou) {
    const motivo = SEM_INFRA.find((m) => saida.includes(m));
    if (motivo) {
      infra++;
      console.log(`  INFRA | ${nome.padEnd(16)} sem conexão (${motivo})`);
      return;
    }
    falhas++;
    const linhasDeFalha = saida.split("\n").filter((l) => l.includes("FALHA"));
    /*
     * Sem nenhuma linha de FALHA, o teste não reprovou: ele TRAVOU antes de
     * chegar a asserção nenhuma. Aí o que interessa é o erro, e ele não contém
     * a palavra "FALHA" — filtrar por ela imprimia o nome do teste e mais nada.
     *
     * Aconteceu nesta faxina: uma remoção levou junto uma função que o teste
     * importava, e o relatório disse só "FALHA | taxas". O MODULE_NOT_FOUND que
     * explicava tudo ficou no stderr capturado, invisível.
     */
    console.log(`\n  FALHA | ${nome}\n` + (linhasDeFalha.length
      ? linhasDeFalha.join("\n")
      : saida.trim().split("\n").slice(-12).map((l) => "    " + l).join("\n")));
  }
  console.log(`  ${passou ? "ok  " : "FALHA"} | ${nome.padEnd(16)} ${veredito}`);
};

console.log("\n== unitários ==");
for (const t of UNITARIOS) rodar(t, [arquivoDe(t)]);

if (SEM_BANCO) {
  console.log(`\n(pulando ${UNITARIOS_BANCO.length} unitários e ${PONTA.length} de ponta a ponta:`
    + " precisam de DATABASE_URL no .env)");
}

for (const t of SEM_BANCO ? [] : PONTA) {
  if (t === PONTA[0]) console.log(`\n== ponta a ponta contra ${BASE} ==`);

  /*
   * A semente é o único passo que rodava SEM proteção, e por isso era ele que
   * derrubava a suíte inteira quando o banco não respondia: o execFileSync
   * estourava aqui, fora de qualquer `catch`, e o processo morria despejando
   * pilha em vez de dizer "sem conexão". Os testes já passavam por `rodar()`,
   * que trata; a semente não passava por nada.
   */
  let semente;
  try {
    /*
     * `stdio` explícito para CAPTURAR o stderr do seed em vez de deixá-lo
     * vazar. O padrão do execFileSync despeja o stderr do filho direto no
     * terminal, e uma pilha de vinte linhas antes da mensagem limpa enterra
     * justamente a linha que diz o que fazer.
     */
    semente = execFileSync("node", ["scripts/seed.mjs"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const saida = (e.stdout ?? "") + (e.stderr ?? "") + (e.message ?? "");
    const motivo = SEM_INFRA.find((m) => saida.includes(m));

    /* Conta o que REALMENTE deixou de rodar: esta e todas as seguintes. */
    const restantes = PONTA.length - PONTA.indexOf(t);
    infra += restantes;

    if (motivo) {
      console.log(`  INFRA | semente não rodou (${motivo})`
        + ` — ${restantes} de ponta a ponta ficaram de fora`);
    } else {
      /* Causa não reconhecida: aí o detalhe é o que resolve, e ele aparece. */
      console.log(`  INFRA | semente não rodou, por motivo não reconhecido:\n${saida.trim()}`);
    }
    /* Sem semente não há o que testar daqui para baixo, e insistir a cada um
       dos seis só repetiria a mesma mensagem. */
    break;
  }

  /* Compacta: o teste so precisa do objeto, e uma linha so viaja inteira. */
  rodar(t, [arquivoDe(t), JSON.stringify(JSON.parse(semente))]);
}

rmSync("_tmp", { recursive: true, force: true });

/*
 * A suíte apaga as lojas que ela mesma criou.
 *
 * Cada teste limpa a sua no começo, para nascer do zero, mas nenhum limpava no
 * fim — então toda execução deixava uma loja de teste para trás, e elas iam se
 * acumulando no seletor de dashboard junto com as de verdade.
 *
 * A lista é fixa de propósito. Apagar por padrão de nome — tudo que contém
 * "teste" — um dia apagaria a loja de alguém que chamou a oferta de "Teste A/B".
 */
const DESCARTAVEIS = [
  "loja-de-teste", "metricas-teste", "faturamento-teste", "faturamento-outro",
];

/* Sem banco nada foi criado, então não há o que limpar. */
if (!SEM_BANCO) try {
  /*
   * O runner nunca precisou do banco — quem falava com ele eram os testes
   * filhos, cada um carregando o .env por conta. A limpeza é a primeira coisa
   * que ele faz sozinho, e por isso precisa carregar também.
   */
  process.loadEnvFile(".env");
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL);
  const apagadas = await sql`
    DELETE FROM tenants WHERE slug = ANY(${DESCARTAVEIS}) RETURNING slug`;
  if (apagadas.length) {
    console.log(`\nlimpeza: ${apagadas.map((t) => t.slug).join(", ")}`);
  }
} catch (e) {
  /* Limpeza que falha não pode reprovar a suíte — só avisa. */
  console.log(`\naviso: não deu para limpar as lojas de teste (${e.message})`);
}

/*
 * O veredito diz o que REALMENTE rodou.
 *
 * "SUÍTE INTEIRA PASSOU" com treze testes pulados seria a pior mensagem
 * possível: ela afirma cobertura que não houve, e quem lê vai embora achando
 * que as agregações do painel foram conferidas quando nem foram tocadas.
 */
const pulados = SEM_BANCO ? UNITARIOS_BANCO.length + PONTA.length : 0;

/*
 * Infra caída sai ANTES de tudo, e com instrução.
 *
 * Um "SUÍTE(S) COM FALHA" quando o que houve foi timeout até o Neon manda a
 * pessoa procurar defeito onde não há nenhum. A distinção só vale se o veredito
 * também a fizer.
 */
if (infra > 0) {
  console.log(
    `\n${infra} suíte(s) NÃO RODARAM por falta de conexão — isto não é teste reprovado.`
    + "\nConfira a rede e o DATABASE_URL, e rode de novo."
    + (falhas > 0 ? `\n\nE há ${falhas} com FALHA de verdade, acima.` : ""),
  );
} else {
  console.log(`\n${falhas > 0 ? falhas + " SUÍTE(S) COM FALHA"
    : pulados > 0 ? `os ${UNITARIOS.length} sem banco passaram — ${pulados} NÃO RODARAM`
    : "SUÍTE INTEIRA PASSOU"}`);
}
console.log();

/* Infra caída também reprova: a suíte não provou o que devia provar. */
process.exit(falhas === 0 && infra === 0 ? 0 : 1);
