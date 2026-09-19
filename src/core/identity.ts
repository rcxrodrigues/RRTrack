/*
 * Os formatos de `_fbp` e `_fbc`, conferidos antes de enviar.
 *
 *   _fbp = fb.<subdominio>.<criado_em_ms>.<numero_aleatorio>
 *   _fbc = fb.<subdominio>.<criado_em_ms>.<fbclid>
 *
 * Não são convenção nossa: é o que a Meta espera, e valor fora do formato é
 * descartado pelo CAPI em SILÊNCIO — sem erro, só um EMQ que não sobe. É por
 * isso que a conferência existe aqui, antes do envio, em vez de se confiar no
 * que veio do navegador.
 *
 * QUEM GERA são public/rr.js, no navegador. Houve aqui um gerador do lado do
 * servidor, e ele nunca foi chamado: sem GTM e sem o pixel da Meta no site,
 * quem precisa criar os cookies é quem roda na página, não quem recebe o
 * evento. Saiu junto com esta faxina.
 */

const FBP_RE = /^fb\.\d+\.\d{10,}\.\d+$/;
const FBC_RE = /^fb\.\d+\.\d{10,}\..+$/;

export function isValidFbp(v: string | undefined): boolean {
  return !!v && FBP_RE.test(v);
}

export function isValidFbc(v: string | undefined): boolean {
  return !!v && FBC_RE.test(v);
}
