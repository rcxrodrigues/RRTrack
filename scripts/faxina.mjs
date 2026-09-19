/*
 * Limpeza do que sobrou de teste e de cadastro abandonado.
 *
 * POR PADRÃO SÓ MOSTRA. Apagar exige `--aplicar`, e isso não é cerimônia: três
 * tabelas CASCATEIAM, e a cascata leva junto justamente o que não se recupera.
 *
 *   gateway_connections -> orders        (as VENDAS daquela conexão)
 *   destinations        -> dispatches    (o histórico de envio)
 *   ad_accounts         -> ad_spend_daily (o gasto sincronizado)
 *
 * Uma faxina descuidada aqui não deixa a base mais limpa: deixa o faturamento
 * menor, e o sintoma aparece no painel como se as vendas nunca tivessem
 * existido. Por isso a regra abaixo é dura — linha com dependente NÃO É
 * APAGADA, nem com --aplicar. Para essas, o caminho é desativar.
 *
 * O que ele mexe, e por quê:
 *
 *   1. Conexões, pixels e contas SEM CREDENCIAL e SEM DEPENDENTE. São cadastros
 *      que ficaram pela metade; não disparam nada e não guardam nada.
 *
 *   2. `sites.domain` guardado como URL. Parte das linhas tem
 *      "https://transforlar.com/" em vez do hostname, e isso já custou duas
 *      falhas silenciosas (ver core/dominio.ts). A leitura normaliza, mas
 *      deixar torto no banco é convidar o próximo defeito.
 *
 *   3. `sites.collector_host` gerado com a mesma conta quebrada, do tipo
 *      "t.https://transforlar.com/", que não é endereço nenhum.
 *
 * Rodar:
 *   node scripts/faxina.mjs              # só mostra
 *   node scripts/faxina.mjs --aplicar    # executa
 */

import { neon } from "@neondatabase/serverless";

process.loadEnvFile(".env");
const sql = neon(process.env.DATABASE_URL);
const APLICAR = process.argv.includes("--aplicar");

/* Mesma normalização de core/dominio.ts. Duplicada porque este script é
   operação, não produção, e não passa pelo build. */
function dominioDoSite(guardado) {
  return String(guardado ?? "").trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^[^/@]*@/, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^www\./, "");
}

const plural = (n, um, muitos) => `${n} ${n === 1 ? um : muitos}`;
let mudancas = 0;

console.log(APLICAR
  ? "\n=== FAXINA — aplicando ===\n"
  : "\n=== FAXINA — só mostrando. Use --aplicar para executar. ===\n");

/* ------------------------------------------------ 1. cadastros vazios -- */

const ALVOS = [
  {
    tabela: "gateway_connections",
    rotulo: "gateway",
    especie: "gateway",
    dependentes: [
      { tabela: "orders", coluna: "gateway_connection_id", o_que: "venda(s)" },
      { tabela: "webhook_deliveries", coluna: "gateway_connection_id", o_que: "entrega(s)" },
    ],
  },
  {
    tabela: "destinations",
    rotulo: "pixel",
    especie: "platform",
    dependentes: [
      { tabela: "dispatches", coluna: "destination_id", o_que: "disparo(s)" },
    ],
  },
  {
    tabela: "ad_accounts",
    rotulo: "conta de anúncio",
    especie: "platform",
    dependentes: [
      { tabela: "ad_spend_daily", coluna: "ad_account_id", o_que: "linha(s) de gasto" },
    ],
  },
];

for (const alvo of ALVOS) {
  const linhas = await sql(
    `SELECT id, label, ${alvo.especie} AS especie, credentials, active
       FROM ${alvo.tabela} ORDER BY label`,
  );

  const vazias = linhas.filter((l) => Object.keys(l.credentials ?? {}).length === 0);
  if (!vazias.length) continue;

  console.log(`== ${alvo.tabela} — ${plural(vazias.length, "sem credencial", "sem credencial")} ==`);

  for (const l of vazias) {
    /* Conta os dependentes ANTES de qualquer decisão. É esta contagem que
       separa "cadastro abandonado" de "conexão que carrega o faturamento". */
    const presos = [];
    for (const d of alvo.dependentes) {
      const [{ n }] = await sql(
        `SELECT count(*)::int AS n FROM ${d.tabela} WHERE ${d.coluna} = $1`, [l.id],
      );
      if (n > 0) presos.push(`${n} ${d.o_que}`);
    }

    if (presos.length) {
      console.log(`  MANTÉM | ${l.especie}/${l.label}: tem ${presos.join(", ")}`);
      console.log(`         | apagar levaria isso junto. Desative pelo painel, não apague.`);
      continue;
    }

    mudancas++;
    if (!APLICAR) {
      console.log(`  apaga  | ${l.especie}/${l.label}: sem credencial, sem dependente`);
      continue;
    }
    await sql(`DELETE FROM ${alvo.tabela} WHERE id = $1`, [l.id]);
    console.log(`  APAGOU | ${l.especie}/${l.label}`);
  }
  console.log();
}

/* -------------------------------------------- 2 e 3. domínio e coletor -- */

const sites = await sql(
  "SELECT id, domain, collector_host, collector_verified_at FROM sites ORDER BY domain",
);

console.log("== sites — domínio e coletor ==");

for (const s of sites) {
  const limpo = dominioDoSite(s.domain);
  const coletorLimpo = s.collector_host ? dominioDoSite(s.collector_host) : null;

  const trocaDominio = limpo && limpo !== s.domain;
  /* Coletor só é corrigido se continuar dentro do domínio do site. Fora disso
     o valor é lixo e some: um coletor no domínio errado carregaria script de
     terceiro no site da loja. */
  const coletorServe = coletorLimpo
    && coletorLimpo !== s.collector_host
    && (coletorLimpo === limpo || coletorLimpo.endsWith("." + limpo));
  const coletorLixo = s.collector_host && !coletorServe && coletorLimpo !== s.collector_host;

  if (!trocaDominio && !coletorServe && !coletorLixo) {
    console.log(`  ok     | ${s.domain}`);
    continue;
  }

  mudancas++;
  const acoes = [];
  if (trocaDominio) acoes.push(`domínio "${s.domain}" -> "${limpo}"`);
  if (coletorServe) acoes.push(`coletor "${s.collector_host}" -> "${coletorLimpo}"`);
  if (coletorLixo) acoes.push(`coletor "${s.collector_host}" -> nulo (não pertence a ${limpo})`);

  if (!APLICAR) {
    console.log(`  ajusta | ${acoes.join("; ")}`);
    continue;
  }

  /*
   * Mexer no coletor ZERA a verificação. Obrigatório: a data diz "este
   * endereço respondeu", e o endereço acabou de mudar. Mantê-la faria o
   * snippet apontar para um host que ninguém conferiu.
   */
  await sql(
    `UPDATE sites SET domain = $1, collector_host = $2,
            collector_verified_at = CASE WHEN $2 IS DISTINCT FROM collector_host
                                         THEN NULL ELSE collector_verified_at END
      WHERE id = $3`,
    [trocaDominio ? limpo : s.domain, coletorServe ? coletorLimpo : (coletorLixo ? null : s.collector_host), s.id],
  );
  console.log(`  AJUSTOU| ${acoes.join("; ")}`);
}

console.log("\n" + "-".repeat(62));
if (!mudancas) {
  console.log("  Nada a fazer — a base já está limpa.\n");
} else if (APLICAR) {
  console.log(`  ${plural(mudancas, "mudança aplicada", "mudanças aplicadas")}.\n`);
} else {
  console.log(`  ${plural(mudancas, "mudança", "mudanças")} a fazer.`
    + "  Rode de novo com --aplicar para executar.\n");
}
