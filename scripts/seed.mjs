/*
 * Semeia uma loja de teste — genérica de propósito.
 *
 * O RRTrack é multi-loja: nenhuma loja real pertence a este script. O que
 * existe aqui é dado descartável para os testes automatizados rodarem contra
 * um estado conhecido. Loja de verdade se cadastra pelo scripts/cadastrar.mjs.
 */
import { neon } from "@neondatabase/serverless";
import { webcrypto as wc } from "node:crypto";

process.loadEnvFile(".env");
const sql = neon(process.env.DATABASE_URL);

/* Mesma cifragem do src/core/crypto.ts: AES-256-GCM, formato "iv.dados". */
async function encrypt(plain) {
  const bytes = Uint8Array.from(atob(process.env.CREDENTIALS_KEY), (c) => c.charCodeAt(0));
  const key = await wc.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt"]);
  const iv = wc.getRandomValues(new Uint8Array(12));
  const out = await wc.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  const b64 = (b) => btoa(String.fromCharCode(...b));
  return `${b64(iv)}.${b64(new Uint8Array(out))}`;
}

const SEGREDO = "whsec_" + Buffer.from(wc.getRandomValues(new Uint8Array(24))).toString("hex");
const SITE_KEY = "pk_teste_" + Buffer.from(wc.getRandomValues(new Uint8Array(8))).toString("hex");

/* Limpa execuções anteriores para o teste ser sempre do zero. */
await sql`DELETE FROM tenants WHERE slug = 'loja-de-teste'`;

const [t] = await sql`
  INSERT INTO tenants (name, slug, timezone, currency)
  VALUES ('Loja de Teste', 'loja-de-teste', 'America/Sao_Paulo', 'BRL')
  RETURNING id`;

await sql`
  INSERT INTO sites (tenant_id, domain, collector_host, public_key, active)
  VALUES (${t.id}, 'loja-de-teste.exemplo.com.br', 't.loja-de-teste.exemplo.com.br', ${SITE_KEY}, true)
  ON CONFLICT (domain) DO UPDATE SET tenant_id = ${t.id}, public_key = ${SITE_KEY}`;

/* Uma conexão por gateway, cada uma com seu próprio segredo de webhook. */
const conexoes = {};
for (const [id, label] of [
  ["pagou", "Pagou.ai"],
  ["appmax", "Appmax"],
  ["millions", "MillionsPay"],
]) {
  const segredo = "whsec_" + Buffer.from(wc.getRandomValues(new Uint8Array(24))).toString("hex");
  const [c] = await sql`
    INSERT INTO gateway_connections (tenant_id, gateway, label, credentials, webhook_secret, active)
    VALUES (${t.id}, ${id}, ${label}, '{}'::jsonb, ${segredo}, true)
    RETURNING id`;
  conexoes[id] = { connectionId: c.id, webhookSecret: segredo };
}

/*
 * Destino Meta com token falso de propósito: o disparo vai montar o payload
 * inteiro, calcular as chaves de correspondência e só então falhar no envio.
 * É o que permite auditar o EMQ sem precisar de credencial real.
 */
const creds = JSON.stringify({ accessToken: await encrypt("EAA_token_falso_para_teste") });
await sql`
  INSERT INTO destinations (tenant_id, platform, label, external_id, credentials, config, active)
  VALUES (${t.id}, 'meta', 'Pixel de teste', '1234567890123456', ${creds}::jsonb, '{}'::jsonb, true)`;

console.log(JSON.stringify({
  tenantId: t.id,
  siteKey: SITE_KEY,
  /* Compatibilidade com o teste original, que usa o pagou. */
  webhookSecret: conexoes.pagou.webhookSecret,
  gateways: conexoes,
}, null, 2));
