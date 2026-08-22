/*
 * Cadastro de loja.
 *
 * Cria tudo que uma loja precisa para receber venda de verdade: a conta, o
 * site, uma conexão por gateway e os destinos de conversão. No fim imprime as
 * URLs de webhook prontas para colar no painel de cada gateway, e o trecho de
 * HTML que vai no site.
 *
 * Existe porque o painel ainda não tem tela de cadastro. Quando tiver, esta
 * lógica vira o formulário — o que o script faz é exatamente o que a tela vai
 * precisar fazer.
 *
 * Uso:
 *   node scripts/cadastrar.mjs --loja "Minha Loja" --slug minhaloja \
 *     --dominio minhaloja.com.br --gateway pagou --gateway millions \
 *     --meta-pixel 1234567890 --meta-token EAAxxxx
 *
 * Sem argumentos, pergunta o que falta. Rodar de novo com o mesmo --slug
 * atualiza a loja em vez de duplicar.
 *
 *   node scripts/cadastrar.mjs --listar     mostra as lojas já cadastradas
 */

import { neon } from "@neondatabase/serverless";
import { webcrypto as wc } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

process.loadEnvFile(".env");

const sql = neon(process.env.DATABASE_URL);
const BASE = process.env.RR_BASE || "https://rr-track.vercel.app";

const GATEWAYS = {
  pagou: {
    label: "Pagou.ai",
    repasse: "sck",
    nota: "O clickId viaja no campo sck do checkout — o rr.js carimba sozinho.",
  },
  millions: {
    label: "MillionsPay",
    repasse: "metadata.rr_click_id",
    nota: "Ao criar a cobrança, mande metadata: { rr_click_id: <clickId> }.",
  },
  appmax: {
    label: "Appmax",
    repasse: "reivindicação",
    nota: "Não tem campo de repasse. O servidor da loja precisa chamar /api/claim ao criar o pedido.",
  },
};

/* ------------------------------------------------------------ argumentos -- */

function parseArgs(argv) {
  const out = { gateway: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const chave = a.slice(2);
    const valor = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    if (chave === "gateway") out.gateway.push(valor);
    else out[chave] = valor;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

/* ------------------------------------------------------------ utilidades -- */

const enc = new TextEncoder();

/* Mesma cifragem do src/core/crypto.ts: AES-256-GCM, formato "iv.dados". */
async function encrypt(plain) {
  const raw = process.env.CREDENTIALS_KEY;
  if (!raw) throw new Error("CREDENTIALS_KEY ausente no .env");
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) throw new Error("CREDENTIALS_KEY precisa ter 32 bytes em base64");
  const key = await wc.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt"]);
  const iv = wc.getRandomValues(new Uint8Array(12));
  const out = await wc.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain));
  const b64 = (b) => btoa(String.fromCharCode(...b));
  return `${b64(iv)}.${b64(new Uint8Array(out))}`;
}

const aleatorio = (n) => Buffer.from(wc.getRandomValues(new Uint8Array(n))).toString("hex");

function limparDominio(d) {
  return d.trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

/* --------------------------------------------------------------- listar -- */

if (args.listar) {
  const lojas = await sql`
    SELECT t.id, t.name, t.slug, t.timezone,
           (SELECT domain FROM sites WHERE tenant_id = t.id LIMIT 1) AS dominio,
           (SELECT public_key FROM sites WHERE tenant_id = t.id LIMIT 1) AS chave
    FROM tenants t ORDER BY t.created_at`;

  if (lojas.length === 0) {
    console.log("\nNenhuma loja cadastrada ainda.\n");
    process.exit(0);
  }

  for (const l of lojas) {
    console.log(`\n${l.name}  (${l.slug})`);
    console.log(`  domínio    ${l.dominio ?? "—"}`);
    console.log(`  site_key   ${l.chave ?? "—"}`);

    const conns = await sql`
      SELECT gateway, label, webhook_secret, active
      FROM gateway_connections WHERE tenant_id = ${l.id} ORDER BY gateway`;
    for (const c of conns) {
      console.log(`  webhook ${c.gateway.padEnd(9)} ${BASE}/api/webhook/${c.gateway}/${c.webhook_secret}${c.active ? "" : "  (inativa)"}`);
    }

    const dests = await sql`
      SELECT platform, label, external_id, active
      FROM destinations WHERE tenant_id = ${l.id} ORDER BY platform`;
    for (const d of dests) {
      console.log(`  destino ${d.platform.padEnd(9)} ${d.external_id}${d.active ? "" : "  (inativo)"}`);
    }
  }
  console.log();
  process.exit(0);
}

/* ------------------------------------------------------------ perguntas -- */

const rl = createInterface({ input: stdin, output: stdout });
const perguntar = async (texto, padrao) => {
  if (!stdin.isTTY) return padrao ?? "";
  const r = (await rl.question(padrao ? `${texto} [${padrao}] ` : `${texto} `)).trim();
  return r || padrao || "";
};

console.log("\n=== Cadastro de loja no RRTrack ===\n");

const nome = args.loja || await perguntar("Nome da loja:");
if (!nome) { console.error("\nErro: nome da loja é obrigatório (--loja)\n"); process.exit(1); }

const slug = (args.slug || await perguntar("Identificador curto (sem espaço):", nome.toLowerCase().replace(/[^a-z0-9]+/g, "-")))
  .toLowerCase().replace(/[^a-z0-9-]/g, "");

const dominioBruto = args.dominio || await perguntar("Domínio do site (ex: minhaloja.com.br):");
if (!dominioBruto) { console.error("\nErro: domínio é obrigatório (--dominio)\n"); process.exit(1); }
const dominio = limparDominio(dominioBruto);

let gateways = args.gateway.filter((g) => GATEWAYS[g]);
if (gateways.length === 0) {
  const r = await perguntar(`Gateways (${Object.keys(GATEWAYS).join(", ")}), separados por vírgula:`, "pagou");
  gateways = r.split(",").map((g) => g.trim()).filter((g) => GATEWAYS[g]);
}
if (gateways.length === 0) { console.error("\nErro: nenhum gateway válido\n"); process.exit(1); }

const metaPixel = args["meta-pixel"] || await perguntar("Pixel/dataset da Meta (deixe vazio para pular):");
const metaToken = metaPixel ? (args["meta-token"] || await perguntar("Token de usuário de sistema da Meta:")) : "";
const metaTeste = metaPixel ? (args["meta-test-code"] || await perguntar("Código de teste da Meta (opcional):")) : "";

const appmaxId = gateways.includes("appmax")
  ? (args["appmax-client-id"] || await perguntar("Appmax client_id (para buscar o comprador):")) : "";
const appmaxSecret = appmaxId
  ? (args["appmax-client-secret"] || await perguntar("Appmax client_secret:")) : "";

rl.close();

/* -------------------------------------------------------------- gravar -- */

const [existente] = await sql`SELECT id FROM tenants WHERE slug = ${slug}`;

let tenantId;
if (existente) {
  tenantId = existente.id;
  await sql`UPDATE tenants SET name = ${nome} WHERE id = ${tenantId}`;
  console.log(`\nLoja "${slug}" já existia — atualizando.`);
} else {
  const [t] = await sql`
    INSERT INTO tenants (name, slug, timezone, currency)
    VALUES (${nome}, ${slug}, 'America/Sao_Paulo', 'BRL') RETURNING id`;
  tenantId = t.id;
}

/*
 * A chave pública identifica o site no coletor. Reaproveitamos a existente:
 * trocar obrigaria a mexer no HTML do site sem necessidade.
 */
const [siteAtual] = await sql`SELECT public_key FROM sites WHERE domain = ${dominio}`;
const siteKey = siteAtual?.public_key ?? `pk_${slug}_${aleatorio(8)}`;

await sql`
  INSERT INTO sites (tenant_id, domain, collector_host, public_key, active)
  VALUES (${tenantId}, ${dominio}, ${"t." + dominio}, ${siteKey}, true)
  ON CONFLICT (domain) DO UPDATE
    SET tenant_id = ${tenantId}, collector_host = ${"t." + dominio}, active = true`;

const conexoes = [];
for (const g of gateways) {
  /* Segredo existente é preservado: trocar quebraria o webhook já configurado. */
  const [atual] = await sql`
    SELECT id, webhook_secret FROM gateway_connections
    WHERE tenant_id = ${tenantId} AND gateway = ${g}`;

  const segredo = atual?.webhook_secret ?? `whsec_${aleatorio(24)}`;

  let cred = {};
  if (g === "appmax" && appmaxId && appmaxSecret) {
    cred = { clientId: await encrypt(appmaxId), clientSecret: await encrypt(appmaxSecret) };
  }

  if (atual) {
    if (Object.keys(cred).length) {
      await sql`UPDATE gateway_connections SET credentials = ${JSON.stringify(cred)}::jsonb, active = true WHERE id = ${atual.id}`;
    } else {
      await sql`UPDATE gateway_connections SET active = true WHERE id = ${atual.id}`;
    }
  } else {
    await sql`
      INSERT INTO gateway_connections (tenant_id, gateway, label, credentials, webhook_secret, active)
      VALUES (${tenantId}, ${g}, ${GATEWAYS[g].label}, ${JSON.stringify(cred)}::jsonb, ${segredo}, true)`;
  }

  conexoes.push({ gateway: g, segredo, temCredencial: Object.keys(cred).length > 0 });
}

if (metaPixel && metaToken) {
  const cred = JSON.stringify({ accessToken: await encrypt(metaToken) });
  const [atual] = await sql`
    SELECT id FROM destinations
    WHERE tenant_id = ${tenantId} AND platform = 'meta' AND external_id = ${metaPixel}`;

  if (atual) {
    /*
     * O código de teste só é tocado quando veio um valor. Sem esta guarda,
     * rodar o script de novo para trocar o token apagaria o código que já
     * estava configurado — e o silêncio disso é pior que o erro: os eventos
     * continuariam saindo, só que sumiriam da aba de teste do Events Manager.
     */
    await sql`
      UPDATE destinations SET credentials = ${cred}::jsonb, active = true
      WHERE id = ${atual.id}`;
    if (metaTeste) {
      await sql`UPDATE destinations SET test_event_code = ${metaTeste} WHERE id = ${atual.id}`;
    }
  } else {
    await sql`
      INSERT INTO destinations (tenant_id, platform, label, external_id, credentials, config, test_event_code, active)
      VALUES (${tenantId}, 'meta', ${"Pixel " + nome}, ${metaPixel}, ${cred}::jsonb, '{}'::jsonb, ${metaTeste || null}, true)`;
  }
}

/* ------------------------------------------------------------- relatório -- */

const linha = (c = "─") => c.repeat(74);

console.log("\n" + linha("━"));
console.log(`  ${nome}`);
console.log(linha("━"));

console.log("\n1. COLE NO SITE, ANTES DO </head>\n");
console.log(`   <script>`);
console.log(`     window.RRTrackConfig = {`);
console.log(`       siteKey: "${siteKey}",`);
console.log(`       endpoint: "${BASE}/rr/collect"`);
console.log(`     };`);
console.log(`   </script>`);
console.log(`   <script src="${BASE}/rr.js" async></script>`);

console.log("\n\n2. URL DE WEBHOOK — uma por gateway, cole no painel de cada um\n");
for (const c of conexoes) {
  const g = GATEWAYS[c.gateway];
  console.log(`   ${g.label}`);
  console.log(`   ${BASE}/api/webhook/${c.gateway}/${c.segredo}`);
  console.log(`   clickId: ${g.repasse}`);
  console.log(`   ${g.nota}`);
  if (c.gateway === "appmax" && !c.temCredencial) {
    console.log(`   ATENÇÃO: sem client_id/client_secret, a Appmax entrega só 5 chaves`);
    console.log(`            (nenhum dado do comprador). Rode de novo com --appmax-client-id.`);
  }
  console.log();
}

console.log(linha());
console.log("  Guarde estas URLs: o segredo faz parte delas e é o que impede");
console.log("  alguém de forjar uma venda. Não publique em lugar nenhum.");
console.log(linha() + "\n");

if (!metaPixel) {
  console.log("  Nenhum destino Meta configurado — as vendas entram no painel,");
  console.log("  mas nada é enviado para plataforma de anúncio.\n");
}
