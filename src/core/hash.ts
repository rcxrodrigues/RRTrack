/*
 * Normalização e hash de dados pessoais para as APIs de conversão.
 *
 * Meta, Google e TikTok todos exigem SHA-256 de texto normalizado. O hash é a
 * parte fácil; o que separa um EMQ 5 de um EMQ 9 é a normalização — hash de
 * "Ana@Gmail.com " não bate com hash de "ana@gmail.com", e o telefone
 * brasileiro é o campo que mais se erra.
 *
 * Nada de PII em claro sai deste módulo para uma plataforma de anúncio.
 */

const enc = new TextEncoder();

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Remove acentos. "José" -> "jose". As plataformas normalizam para a-z. */
function semAcento(v: string): string {
  return v.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function normalizeEmail(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (!v.includes("@") || v.length < 6) return null;
  return v;
}

/*
 * Telefone no formato E.164 sem o "+", que é o que as três plataformas querem.
 *
 * O caso brasileiro tem duas armadilhas. A primeira é o DDI: gateways devolvem
 * "(11) 99999-8888" tanto quanto "+5511999998888", e prefixar 55 num número que
 * já tem 55 gera um hash que nunca bate. A segunda é o dígito 9 dos celulares:
 * um número de 10 dígitos pode ser fixo (válido) ou celular antigo sem o 9
 * (inválido hoje) — não dá para adivinhar, então preservamos como veio.
 */
export function normalizePhone(raw: string, defaultCountry = "55"): string | null {
  let d = raw.replace(/\D/g, "");
  if (!d) return null;

  /* Zeros de discagem nacional/internacional: "011", "0055". */
  d = d.replace(/^0+/, "");

  if (d.startsWith(defaultCountry) && d.length >= 12 && d.length <= 13) {
    /* Já tem DDI. */
  } else if (d.length === 10 || d.length === 11) {
    /* DDD + número, sem DDI. */
    d = defaultCountry + d;
  } else if (d.length < 10) {
    /* Curto demais para ter DDD — inútil como chave de correspondência. */
    return null;
  }

  if (d.length < 11 || d.length > 15) return null;
  return d;
}

/** Nomes: minúsculas, sem acento, só letras. */
export function normalizeName(raw: string): string | null {
  const v = semAcento(raw.trim().toLowerCase()).replace(/[^a-z]/g, "");
  return v || null;
}

/*
 * Divide um nome completo em primeiro e último. Gateways quase sempre mandam
 * o nome inteiro num campo só, e mandar tudo como `fn` desperdiça o `ln`.
 * Partículas ("de", "da", "dos") não são sobrenome útil sozinhas.
 */
const PARTICULAS = new Set(["de", "da", "do", "das", "dos", "e"]);

export function splitName(full: string): { first?: string; last?: string } {
  const partes = full
    .trim()
    .split(/\s+/)
    .map((p) => normalizeName(p))
    .filter((p): p is string => !!p && !PARTICULAS.has(p));

  if (partes.length === 0) return {};
  if (partes.length === 1) return { first: partes[0] };
  return { first: partes[0], last: partes[partes.length - 1] };
}

/** CEP: só dígitos. */
export function normalizeZip(raw: string): string | null {
  const d = raw.replace(/\D/g, "");
  return d.length >= 5 ? d : null;
}

export function normalizeCity(raw: string): string | null {
  const v = semAcento(raw.trim().toLowerCase()).replace(/[^a-z]/g, "");
  return v || null;
}

/** UF em duas letras minúsculas. */
export function normalizeState(raw: string): string | null {
  const v = semAcento(raw.trim().toLowerCase()).replace(/[^a-z]/g, "");
  return v.length === 2 ? v : null;
}

export function normalizeCountry(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  return v.length === 2 ? v : null;
}

/** Hash de um valor já normalizado; `null` entra, `undefined` sai. */
export async function hashOrUndefined(
  value: string | null | undefined,
): Promise<string | undefined> {
  if (!value) return undefined;
  return sha256(value);
}
