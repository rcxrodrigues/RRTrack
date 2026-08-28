/*
 * Regera a lista de faixas de IP da infraestrutura da Meta.
 *
 *   node scripts/atualizar-redes.mjs
 *
 * Por que a lista mora no repositório em vez de ser buscada na hora: o coletor
 * roda no caminho quente, em toda página vista de toda loja. Uma consulta a
 * serviço externo ali acrescentaria latência e, pior, um modo de falha — se o
 * serviço caísse, ou passaríamos a contar robô como gente, ou passaríamos a
 * recusar gente. Arquivo no repositório não cai, e a mudança fica visível no
 * diff de quem revisar.
 *
 * A fonte é o RIPE, que publica os prefixos anunciados por cada ASN. AS32934 é
 * a Meta. Rodar isto de tempos em tempos basta: faixa de ASN muda em meses, não
 * em dias, e faixa nova não anunciada só significa um robô a mais contado —
 * nunca um comprador a menos.
 */

import { writeFileSync } from "node:fs";

const ASNS = [
  { asn: 32934, nome: "Meta (Facebook, Instagram, WhatsApp)" },
];

const prefixos = [];

for (const { asn, nome } of ASNS) {
  const url = `https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS${asn}`;
  process.stdout.write(`buscando AS${asn} — ${nome}... `);

  const r = await fetch(url);
  if (!r.ok) {
    console.error(`\nRIPE respondeu ${r.status}. Nada foi escrito.`);
    process.exit(1);
  }

  const j = await r.json();
  const lista = j?.data?.prefixes?.map((p) => p.prefix).filter(Boolean) ?? [];

  /*
   * Recusa lista vazia ou curta demais em vez de gravar. Um arquivo vazio não
   * daria erro em lugar nenhum — só desligaria o filtro em silêncio, que é o
   * tipo de falha que este projeto já pagou caro para aprender a evitar.
   */
  if (lista.length < 50) {
    console.error(`\nsó ${lista.length} prefixos para AS${asn}. Suspeito. Nada foi escrito.`);
    process.exit(1);
  }

  console.log(`${lista.length} prefixos`);
  prefixos.push(...lista);
}

const v4 = [...new Set(prefixos.filter((p) => !p.includes(":")))].sort();
const v6 = [...new Set(prefixos.filter((p) => p.includes(":")))].sort();

const arquivo = `/*
 * Faixas de IP da infraestrutura da Meta — GERADO, não edite à mão.
 *
 * Regere com:  node scripts/atualizar-redes.mjs
 *
 * Origem: RIPE, prefixos anunciados por AS32934.
 * Gerado em ${new Date().toISOString().slice(0, 10)}.
 */

export const META_V4: readonly string[] = [
${v4.map((p) => `  "${p}",`).join("\n")}
];

export const META_V6: readonly string[] = [
${v6.map((p) => `  "${p}",`).join("\n")}
];
`;

writeFileSync("src/core/redes-meta.ts", arquivo, "utf8");
console.log(`\nsrc/core/redes-meta.ts: ${v4.length} faixas IPv4, ${v6.length} IPv6`);
