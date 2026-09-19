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

/*
 * Um valor guardado em `collector_host` pode ser CORRIGIDO para virar coletor?
 *
 * Coletor tem de ser SUBDOMÍNIO, e é aí que estava o defeito: o teste original
 * aceitava também `c === limpo`. O limpador, aplicado a
 * "t.https://transforlar.com/", devolve
 * "transforlar.com" — ele lê "t.https" como esquema e come o prefixo inteiro.
 * Isso passava por "pertence ao domínio" e seria GRAVADO, apontando o coletor
 * para a loja em si, onde vive o Shopify, não o RRTrack.
 *
 * Prefixo torto não tem conserto automático: ninguém sabe se o dono queria
 * "t." ou "track.". Então vira nulo, e a pessoa digita o certo no painel — uma
 * linha a mais de trabalho, e zero chance de gravar besteira.
 */
function serveComoColetor(guardado, dominio) {
  if (!guardado) return false;
  const limpo = dominioDoSite(dominio);
  const c = dominioDoSite(guardado);
  /*
   * `endsWith("." + limpo)` já exclui o apex sozinho: "transforlar.com" não
   * termina em ".transforlar.com". Acrescentar `c !== limpo` seria condição
   * que nunca dispara — e condição morta mente sobre o que o código verifica.
   */
  return !!c && c !== guardado && c.endsWith("." + limpo);
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
  const coletorServe = serveComoColetor(s.collector_host, s.domain);
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

/* --------------------------------- 3b. site em domínio reservado -------- */

/*
 * `exemplo.com` e `example.com` são RESERVADOS pela RFC 2606 justamente para
 * documentação e teste. Ninguém vende por eles, então um site ativo ali é
 * resto de QA — e não é palpite: é o que o registro desses domínios significa.
 *
 * Isto importa mais do que parece. O painel escolhe UM site por loja, e
 * ordenar por domínio (que é o que o torna estável) faz
 * "qa-trocado.exemplo.com" vir ANTES de "transforlar.com" no alfabeto. A loja
 * real fica com a tela do site de teste, e a verificação do coletor grava no
 * lugar errado.
 *
 * DESATIVA, não apaga: `click_sessions.site_id` aponta para cá, e mesmo sendo
 * `set null` a coluna guarda de onde a visita veio. Desativado some da escolha
 * do painel e o histórico fica.
 */
const RESERVADOS = ["exemplo.com", "example.com", "example.org", "example.net"];
const reservado = (d) => RESERVADOS.some((r) => d === r || d.endsWith("." + r))
  || /\.(test|invalid|localhost)$/.test(d);

const deQa = sites.filter((s) => s.active && reservado(dominioDoSite(s.domain)));
if (deQa.length) {
  console.log("\n== sites em domínio reservado (RFC 2606) ==");
  for (const s of deQa) {
    mudancas++;
    if (!APLICAR) {
      console.log(`  desativa | ${s.domain}: domínio reservado não é loja de verdade`);
      continue;
    }
    await sql("UPDATE sites SET active = false WHERE id = $1", [s.id]);
    console.log(`  DESATIVOU| ${s.domain}`);
  }
}

/* ------------------------------ 3c. loja com mais de um site ativo ------ */

/*
 * Depois de desativar o que é de teste, ainda pode sobrar loja com dois sites
 * de verdade. Aqui o script NÃO decide: o painel escolhe um por ordem
 * alfabética, e qual dos dois é "o certo" só quem conhece a operação sabe.
 * Mas avisa, porque escolher em silêncio foi o que produziu a tela confusa.
 */
const porLoja = await sql(`
  SELECT t.name AS loja, count(*)::int AS n,
         string_agg(s.domain, ', ' ORDER BY s.domain) AS dominios
    FROM sites s JOIN tenants t ON t.id = s.tenant_id
   WHERE s.active GROUP BY t.name HAVING count(*) > 1`);

if (porLoja.length) {
  console.log("\n== lojas com MAIS DE UM site ativo ==");
  for (const l of porLoja) {
    console.log(`  ATENÇÃO| ${l.loja}: ${l.n} sites — ${l.dominios}`);
    console.log(`         | o painel usa o PRIMEIRO em ordem alfabética.`);
    console.log(`         | Se não for o certo, desative o outro pelo painel.`);
  }
}

/* ------------------------------------- 4. comprador em claro (só avisa) -- */

/*
 * `orders.customer` sempre teve o comentário "cifrado em repouso". Nem sempre
 * esteve: quem gravou venda antes da correção tem nome, e-mail, telefone, CPF e
 * endereço legíveis no jsonb. Um dump de suporte ou um backup mal guardado sai
 * com o cadastro inteiro.
 *
 * Aqui só CONTA, nunca conserta — cifrar exige a chave e é trabalho do
 * scripts/cifrar-compradores.cjs, que é idempotente. Misturar as duas coisas
 * faria uma faxina de rotina mexer em dado pessoal sem ninguém pedir.
 *
 * A detecção é pelo FORMATO do cifrado ("iv.texto", ambos em base64), e não por
 * tentativa de decifrar: a faxina não precisa da chave para responder
 * "sobrou algo em claro?".
 */
const CIFRADO = /^[A-Za-z0-9+/=]{12,}\.[A-Za-z0-9+/=]{16,}$/;

const compradores = await sql(
  "SELECT id, customer FROM orders WHERE customer IS NOT NULL AND customer::text <> '{}'",
);
const emClaro = compradores.filter((o) =>
  Object.values(o.customer ?? {}).some((v) => typeof v === "string" && v && !CIFRADO.test(v)),
);

console.log("\n== compradores guardados em orders.customer ==");
if (!compradores.length) {
  console.log("  --     | nenhuma venda com comprador guardado");
} else if (!emClaro.length) {
  console.log(`  ok     | ${plural(compradores.length, "venda", "vendas")}, todas cifradas`);
  console.log("         | scripts/cifrar-compradores.cjs já cumpriu o papel e pode sair do repositório");
} else {
  console.log(`  ATENÇÃO| ${plural(emClaro.length, "venda", "vendas")} com dado pessoal EM CLARO`);
  console.log(`         | de ${plural(compradores.length, "venda", "vendas")} com comprador guardado.`);
  console.log("         | Conserto: node scripts/cifrar-compradores.cjs (idempotente).");
  console.log("         | A faxina não faz isso sozinha — cifrar mexe em dado pessoal.");
}

/* ------------------------------ chaves que identificam a loja sozinhas -- */

/*
 * `sites.public_key` e `gateway_connections.webhook_secret` são chaves de
 * busca GLOBAIS: o coletor e o webhook descobrem a loja por elas, sem
 * `tenant_id` na consulta, porque o tenant é justamente o que elas respondem.
 * Duas linhas com o mesmo valor fazem o evento — ou a VENDA — entrar na loja
 * errada, com o `limit(1)` escolhendo uma das duas. Sem erro nenhum.
 *
 * A migração 0006 põe índice único nas duas, e é por isso que esta conferência
 * existe aqui: criar índice único em cima de duplicata FALHA, e a mensagem do
 * Postgres não diz quais linhas são. Rodar a faxina antes do `db:push` diz.
 */
console.log("\n== chaves que identificam a loja sozinhas ==");

const duplicadas = [
  ["sites.public_key", await sql(
    "SELECT public_key AS valor, count(*)::int AS n, array_agg(domain) AS onde"
    + " FROM sites GROUP BY public_key HAVING count(*) > 1")],
  ["gateway_connections.webhook_secret", await sql(
    "SELECT webhook_secret AS valor, count(*)::int AS n, array_agg(label) AS onde"
    + " FROM gateway_connections GROUP BY webhook_secret HAVING count(*) > 1")],
];

let houveDuplicata = false;
for (const [coluna, linhas] of duplicadas) {
  if (!linhas.length) {
    console.log(`  ok     | ${coluna}: sem repetição`);
    continue;
  }
  houveDuplicata = true;
  console.log(`  ATENÇÃO| ${coluna}: ${plural(linhas.length, "valor repetido", "valores repetidos")}`);
  for (const l of linhas) {
    /* O VALOR NÃO É IMPRESSO: é segredo de webhook e chave de site. O que
       identifica a linha para quem for consertar é onde ela está. */
    console.log(`         | ${l.n}x em ${(l.onde ?? []).join(", ")}`);
  }
  console.log("         | A migração 0006 vai FALHAR enquanto isso existir.");
  console.log("         | Conserto: regere a chave da linha duplicada pelo painel.");
}
if (houveDuplicata) {
  console.log("         | A faxina não regera sozinha — trocar a chave de um site");
  console.log("         | derruba o snippet já publicado, e trocar o segredo do");
  console.log("         | webhook derruba a URL cadastrada no painel do gateway.");
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
