/* Semeia uma loja de teste: tenant, site, conexão de gateway e destino Meta. */
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
const SITE_KEY = "pk_flore_" + Buffer.from(wc.getRandomValues(new Uint8Array(8))).toString("hex");

/* Limpa execuções anteriores para o teste ser sempre do zero. */
await sql`DELETE FROM tenants WHERE slug = 'flore'`;

const [t] = await sql`
  INSERT INTO tenants (name, slug, timezone, currency)
  VALUES ('Florè Cosméticos', 'flore', 'America/Sao_Paulo', 'BRL')
  RETURNING id`;

await sql`
  INSERT INTO sites (tenant_id, domain, collector_host, public_key, active)
  VALUES (${t.id}, 'florecomesticos.store', 't.florecomesticos.store', ${SITE_KEY}, true)
  ON CONFLICT (domain) DO UPDATE SET tenant_id = ${t.id}, public_key = ${SITE_KEY}`;

const [conn] = await sql`
  INSERT INTO gateway_connections (tenant_id, gateway, label, credentials, webhook_secret, active)
  VALUES (${t.id}, 'pagou', 'Pagou.ai — Florè', '{}'::jsonb, ${SEGREDO}, true)
  RETURNING id`;

/*
 * Destino Meta com token falso de propósito: o disparo vai montar o payload
 * inteiro, calcular as chaves de correspondência e só então falhar no envio.
 * É o que permite auditar o EMQ sem precisar de credencial real.
 */
const creds = JSON.stringify({ accessToken: await encrypt("EAA_token_falso_para_teste") });
await sql`
  INSERT INTO destinations (tenant_id, platform, label, external_id, credentials, config, active)
  VALUES (${t.id}, 'meta', 'Pixel Florè', '1234567890123456', ${creds}::jsonb, '{}'::jsonb, true)`;

console.log(JSON.stringify({
  tenantId: t.id,
  connectionId: conn.id,
  siteKey: SITE_KEY,
  webhookSecret: SEGREDO,
}, null, 2));
