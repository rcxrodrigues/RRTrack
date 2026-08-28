/*
 * O IP é de datacenter da Meta?
 *
 * O agente resolve metade do problema: robô que se declara robô a gente
 * descarta lendo o `user-agent`. A outra metade não se declara. A revisão de
 * anúncio da Meta abre a página com o MESMO agente do app do Facebook — o
 * agente de um comprador de verdade — e só o IP entrega.
 *
 * Os números da primeira semana de tráfego pago da Florè, que motivaram isto:
 *
 *     173.252.70.35   Gallatin      2 eventos, nenhum pulso
 *     31.13.115.2     Luleå         2 eventos, nenhum pulso
 *     66.220.149.32   Prineville    2 eventos, nenhum pulso
 *     177.55.225.163  Belo Horizonte  8 eventos   <- gente
 *     45.161.75.124   Maceió          3 eventos   <- gente
 *
 * Os três primeiros são AS32934. Tentei separar por comportamento antes de
 * chegar aqui — contagem de eventos, pulso, tamanho de tela — e não dá: um
 * comprador que abre, olha e fecha também deixa dois eventos e nenhum pulso.
 * O IP é o único sinal que separa sem chutar.
 *
 * A Meta não vende internet para consumidor. Ninguém navega de um IP dela por
 * acidente, e por isso o corte pode ser total sem risco de derrubar comprador.
 */

import { META_V4, META_V6 } from "./redes-meta";

/* ------------------------------------------------------------ IPv4 ------ */

function ipv4ParaNumero(ip: string): number | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;

  let n = 0;
  for (const parte of p) {
    if (!/^\d{1,3}$/.test(parte)) return null;
    const o = Number(parte);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n;
}

/*
 * As faixas são convertidas UMA vez, quando o módulo carrega, e não a cada
 * requisição. São 238 faixas IPv4 e 337 IPv6: reinterpretar o texto delas em
 * toda página vista de toda loja seria trabalho repetido no caminho mais quente
 * que existe aqui.
 */
const V4 = META_V4.map((cidr) => {
  const [base, bits] = cidr.split("/");
  const n = base ? ipv4ParaNumero(base) : null;
  const b = Number(bits);
  if (n === null || !Number.isInteger(b) || b < 0 || b > 32) return null;
  /* Máscara de 0 bits é um caso à parte: `<<32` não desloca nada em JS. */
  const mascara = b === 0 ? 0 : (~0 << (32 - b)) >>> 0;
  return { base: (n & mascara) >>> 0, mascara };
}).filter((x): x is { base: number; mascara: number } => x !== null);

/* ------------------------------------------------------------ IPv6 ------ */

function ipv6ParaBigInt(ip: string): bigint | null {
  let texto = ip.trim().toLowerCase();
  /* Endereço com zona ("fe80::1%eth0") ou entre colchetes. */
  texto = texto.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  if (!texto.includes(":")) return null;

  /* Forma mista, com IPv4 no fim: ::ffff:1.2.3.4 */
  const v4 = texto.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4?.[1]) {
    const n = ipv4ParaNumero(v4[1]);
    if (n === null) return null;
    const alto = (n >>> 16) & 0xffff;
    const baixo = n & 0xffff;
    texto = texto.slice(0, v4.index) + alto.toString(16) + ":" + baixo.toString(16);
  }

  const lados = texto.split("::");
  if (lados.length > 2) return null;

  const parte = (s: string) => (s ? s.split(":").filter((x) => x !== "") : []);
  const esquerda = parte(lados[0] ?? "");
  const direita = lados.length === 2 ? parte(lados[1] ?? "") : [];

  const faltam = 8 - esquerda.length - direita.length;
  if (faltam < 0 || (lados.length === 1 && faltam !== 0)) return null;

  const grupos = [...esquerda, ...Array(faltam).fill("0"), ...direita];

  let n = 0n;
  for (const g of grupos) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

const CHEIO_V6 = (1n << 128n) - 1n;

const V6 = META_V6.map((cidr) => {
  const [base, bits] = cidr.split("/");
  const n = base ? ipv6ParaBigInt(base) : null;
  const b = Number(bits);
  if (n === null || !Number.isInteger(b) || b < 0 || b > 128) return null;
  const mascara = b === 0 ? 0n : (CHEIO_V6 << BigInt(128 - b)) & CHEIO_V6;
  return { base: n & mascara, mascara };
}).filter((x): x is { base: bigint; mascara: bigint } => x !== null);

/* ------------------------------------------------------------ resposta -- */

/**
 * `true` quando o IP pertence à infraestrutura da Meta.
 *
 * IP ausente ou malformado devolve `false`: na dúvida, conta como gente. O
 * erro de contar um robô a mais é um número levemente inflado; o de descartar
 * uma pessoa é uma venda que some do painel sem deixar rastro.
 */
export function ehRedeDaMeta(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const texto = ip.trim();
  if (!texto) return false;

  if (texto.includes(":")) {
    const n = ipv6ParaBigInt(texto);
    if (n === null) return false;
    return V6.some((f) => (n & f.mascara) === f.base);
  }

  const n = ipv4ParaNumero(texto);
  if (n === null) return false;
  return V4.some((f) => ((n & f.mascara) >>> 0) === f.base);
}

/** Quantas faixas estão carregadas. Serve para o teste provar que não é zero. */
export function totalDeFaixas(): { v4: number; v6: number } {
  return { v4: V4.length, v6: V6.length };
}
