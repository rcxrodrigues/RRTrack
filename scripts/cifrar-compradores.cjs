/*
 * Cifra os compradores que ficaram em claro em `orders.customer`.
 *
 * A coluna sempre teve o comentário "cifrado em repouso" e não estava. Quem
 * gravou venda antes da correção tem nome, e-mail, telefone, CPF, endereço e
 * nascimento em claro no jsonb. Esta é a única forma de consertar essas linhas
 * — a partir da correção, toda venda nova já entra cifrada.
 *
 * Roda quantas vezes quiser: quem já está cifrado é reconhecido e pulado. A
 * detecção é por tentativa de decifrar, não por formato do texto, porque um
 * palpite de formato erraria em algum e-mail estranho e cifraria duas vezes.
 *
 * Compilar antes:
 *   npx tsc src/core/crypto.ts --outDir _tmp --rootDir src --target ES2022 \
 *     --module commonjs --moduleResolution node --skipLibCheck --esModuleInterop --strict
 *   echo {"type":"commonjs"} > _tmp/package.json
 *   node scripts/cifrar-compradores.cjs           lista o que faria
 *   node scripts/cifrar-compradores.cjs --aplicar grava
 */
const { neon } = require("@neondatabase/serverless");
process.loadEnvFile(".env");

const { encryptValue, decryptValue } = require("../_tmp/core/crypto.js");
const sql = neon(process.env.DATABASE_URL);
const aplicar = process.argv.includes("--aplicar");

/* Cifrado é o que decifra. Qualquer outra checagem é palpite sobre formato. */
async function jaCifrado(v) {
  try {
    await decryptValue(v);
    return true;
  } catch {
    return false;
  }
}

(async () => {
  const linhas = await sql`
    SELECT o.id, o.gateway_order_id, o.customer, t.slug
    FROM orders o JOIN tenants t ON t.id = o.tenant_id
    WHERE o.customer IS NOT NULL`;

  let emClaro = 0;
  let gravadas = 0;

  for (const l of linhas) {
    const campos = Object.entries(l.customer).filter(
      ([, v]) => typeof v === "string" && v !== "",
    );
    if (campos.length === 0) continue;

    /* Basta um campo em claro para a linha inteira precisar de conserto. */
    const precisa = [];
    for (const [k, v] of campos) {
      if (!(await jaCifrado(v))) precisa.push(k);
    }
    if (precisa.length === 0) continue;

    emClaro++;
    console.log(`  ${l.slug} · pedido ${l.gateway_order_id} · ${precisa.join(", ")}`);

    if (!aplicar) continue;

    const novo = {};
    for (const [k, v] of campos) {
      novo[k] = precisa.includes(k) ? await encryptValue(v) : v;
    }

    await sql`UPDATE orders SET customer = ${JSON.stringify(novo)}::jsonb WHERE id = ${l.id}`;
    gravadas++;
  }

  console.log(
    `\n${linhas.length} venda(s) com comprador, ${emClaro} em claro.`
    + (aplicar
      ? ` ${gravadas} cifrada(s).`
      : "\nNada foi gravado. Rode com --aplicar para corrigir."),
  );
})();
