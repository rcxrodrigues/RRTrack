/*
 * A versão das APIs externas, e a armadilha da variável vazia.
 *
 * Roda pela suíte: `node scripts/testar.mjs` compila os módulos em _tmp antes.
 *
 * POR QUE ISTO EXISTE. A leitura era `process.env.META_GRAPH_VERSION ?? "v26.0"`,
 * e `??` só cai no padrão para `undefined` e `null` — variável DECLARADA E
 * VAZIA passa reto. O `.env.example` apresenta as duas assim (vazias, para usar
 * o padrão), e a Vercel devolve string vazia para um campo que alguém limpou
 * sem apagar. Nos dois casos a URL sairia
 *
 *     https://graph.facebook.com//1234567890/events
 *
 * com uma barra a mais. Isso é 404 em TODA chamada — disparo de conversão e
 * busca de gasto — por um caractere que ninguém procura, porque o erro não diz
 * "versão": diz que o recurso não existe, e manda investigar o pixel.
 *
 * O teste força as quatro formas da variável chegar e trava o comportamento.
 */

let f = 0;
const eq = (l, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) f++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${l}` + (ok ? "" : `\n         obtido:   ${JSON.stringify(g)}\n         esperado: ${JSON.stringify(w)}`)); };

/*
 * O helper é testado DIRETO, e não reimportando o módulo com ambientes
 * diferentes. A primeira versão deste teste fazia isso e passava sem testar
 * nada: a suíte compila para CommonJS, cujo cache é chaveado pelo caminho e
 * ignora a query que serviria para furá-lo, então os quatro cenários recebiam
 * a mesma instância — a primeira, carregada sem a variável. Os três casos que
 * esperavam o padrão passavam por acidente, e só o quarto denunciou.
 */
const { versao, META_GRAPH, META_GRAPH_URL, GOOGLE_ADS } = await import("../_tmp/core/versoes.js");

console.log("\n== como a variável de ambiente chega ==");
eq("ausente usa o padrão", versao(undefined, "v26.0"), "v26.0");
eq("VAZIA usa o padrão — é o caso do .env.example", versao("", "v26.0"), "v26.0");
eq("só espaço usa o padrão", versao("   ", "v26.0"), "v26.0");
eq("definida sobrepõe", versao("v25.0", "v26.0"), "v25.0");
eq("espaço em volta é aparado", versao(" v24.0 ", "v26.0"), "v24.0");

console.log("\n== os valores em vigor ==");
eq("Meta no padrão do repositório", META_GRAPH, "v26.0");
eq("Google Ads no padrão do repositório", GOOGLE_ADS, "v21");

console.log("\n== a URL montada ==");
eq("sem barra dupla", META_GRAPH_URL, "https://graph.facebook.com/v26.0");
/* A barra dupla é o sintoma exato que o helper existe para impedir. */
eq("nem com versão vazia", `https://graph.facebook.com/${versao("", "v26.0")}`.includes("com//"), false);

console.log("\n== a URL é montada a partir da constante, não repetida ==");
/*
 * Quem constrói a URL da Meta tem de usar META_GRAPH_URL. Se alguém voltar a
 * escrever "https://graph.facebook.com/" à mão num adaptador, aquele arquivo
 * para de acompanhar a troca de versão — e o defeito é o pior tipo: metade do
 * sistema numa versão, metade na outra, as duas funcionando.
 */
const { readFileSync, readdirSync } = await import("node:fs");
const suspeitos = [];
for (const dir of ["src/destinations", "src/ads"]) {
  for (const nome of readdirSync(new URL(`../${dir}`, import.meta.url))) {
    if (!nome.endsWith(".ts")) continue;
    const texto = readFileSync(new URL(`../${dir}/${nome}`, import.meta.url), "utf8");
    /* Ignora comentário: a explicação cita a URL de propósito. */
    const codigo = texto.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (/https:\/\/graph\.facebook\.com\/v\d|graph\.facebook\.com\/\$\{(?!META_GRAPH_URL)/.test(codigo)) {
      suspeitos.push(`${dir}/${nome}`);
    }
  }
}
eq("nenhum adaptador remonta a URL da Meta à mão", suspeitos, []);

console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
process.exit(f === 0 ? 0 : 1);
