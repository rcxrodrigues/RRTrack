/*
 * Identificadores de navegador — gerados e mantidos por nós.
 *
 * Sem GTM e sem o pixel da Meta no site, ninguém mais cria o `_fbp` e o `_fbc`.
 * Este módulo assume esse papel. Os formatos abaixo não são convenção nossa:
 * são o que a Meta espera receber, e um valor fora do formato é descartado
 * silenciosamente pelo CAPI — sem erro, só um EMQ que não sobe.
 *
 *   _fbp = fb.<subdominio>.<criado_em_ms>.<numero_aleatorio>
 *   _fbc = fb.<subdominio>.<criado_em_ms>.<fbclid>
 *
 * O índice de subdomínio é 1 para um domínio comum (exemplo.com.br). O valor
 * em si é opaco para a Meta: o que importa é ser estável no mesmo navegador,
 * porque é isso que liga vários eventos à mesma pessoa.
 */

const SUBDOMAIN_INDEX = 1;

export function generateFbp(now: number = Date.now()): string {
  /* Dez dígitos, como o pixel gera. */
  const rand = Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000;
  return `fb.${SUBDOMAIN_INDEX}.${now}.${rand}`;
}

/**
 * Monta o `_fbc` a partir do fbclid da URL.
 *
 * O timestamp precisa ser o momento em que o clique aconteceu, não o momento
 * do envio do evento: a Meta usa essa diferença para julgar a recência da
 * atribuição. Usar Date.now() na hora da compra faz um clique de três dias
 * atrás parecer instantâneo, e a correspondência piora em vez de melhorar.
 */
export function buildFbc(fbclid: string, clickedAt: number = Date.now()): string | null {
  const v = fbclid.trim();
  if (!v) return null;
  return `fb.${SUBDOMAIN_INDEX}.${clickedAt}.${v}`;
}

/** Reaproveita o `_fbc` existente, a menos que tenha chegado um fbclid novo. */
export function resolveFbc(
  existing: string | undefined,
  incomingFbclid: string | undefined,
  clickedAt: number = Date.now(),
): string | undefined {
  if (incomingFbclid) return buildFbc(incomingFbclid, clickedAt) ?? existing;
  return existing;
}

const FBP_RE = /^fb\.\d+\.\d{10,}\.\d+$/;
const FBC_RE = /^fb\.\d+\.\d{10,}\..+$/;

export function isValidFbp(v: string | undefined): boolean {
  return !!v && FBP_RE.test(v);
}

export function isValidFbc(v: string | undefined): boolean {
  return !!v && FBC_RE.test(v);
}

/*
 * Prioridade entre identificadores de clique quando mais de um está presente.
 *
 * Acontece de verdade: alguém clica num anúncio do Facebook, não compra, volta
 * dias depois por uma busca do Google e compra. A sessão carrega fbclid e gclid
 * ao mesmo tempo. Para o painel — que precisa de um dono só por venda — vale o
 * último clique. Para as plataformas, cada uma recebe o seu próprio
 * identificador de qualquer jeito, e nenhuma é privada de dado por causa desta
 * ordem.
 */
export const CLICK_ID_FIELDS = [
  "fbclid",
  "gclid",
  "gbraid",
  "wbraid",
  "ttclid",
  "msclkid",
  "twclid",
  "epik",
  "liFatId",
  "kwaiClickId",
] as const;

export type ClickIdField = (typeof CLICK_ID_FIELDS)[number];

/** Mapeia cada identificador de clique para a plataforma que o emitiu. */
export const CLICK_ID_PLATFORM: Record<ClickIdField, string> = {
  fbclid: "meta",
  gclid: "google",
  gbraid: "google",
  wbraid: "google",
  ttclid: "tiktok",
  msclkid: "microsoft",
  twclid: "twitter",
  epik: "pinterest",
  liFatId: "linkedin",
  kwaiClickId: "kwai",
};
