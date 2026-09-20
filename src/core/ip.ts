/*
 * De onde veio a requisição.
 *
 * A ORDEM DOS CABEÇALHOS É O CONTEÚDO DESTE ARQUIVO. Pegar o primeiro que
 * existir, na ordem errada, produz um IP plausível e errado — e nada acusa.
 *
 * Com a Cloudflare na frente, o `x-forwarded-for` que chega aqui traz o IP da
 * BORDA DA CLOUDFLARE, não o do visitante: a Vercel reescreve o cabeçalho com
 * o IP de quem falou com ela, e quem falou com ela foi o proxy. O sintoma foi
 * uma loja de Belo Horizonte aparecendo como São Paulo e Rio de Janeiro, que é
 * onde ficam os pontos de presença.
 *
 * O estrago não para no mapa. Este IP vai para a Meta como chave de
 * correspondência: mandar o IP de um data center é PIOR que não mandar nada,
 * porque associa a compra a um lugar onde ninguém mora. E é ele que a
 * contenção conta — contar a borda do proxy somaria o mundo inteiro num
 * balde só, e o teto de abuso barraria compradores de verdade.
 *
 * `cf-connecting-ip` vem primeiro porque a própria Cloudflare o sobrescreve na
 * entrada: não dá para forjar de fora.
 *
 * Mora aqui, e não em cada rota, porque já viveu copiado em dois lugares —
 * e cópia que diverge é o defeito mais caro deste repositório (ver a lista de
 * sufixo público em CLAUDE.md). Três leitores, uma ordem.
 */

export function ipDoCliente(req: Request): string | undefined {
  const daCloudflare = req.headers.get("cf-connecting-ip");
  if (daCloudflare?.trim()) return daCloudflare.trim();

  /* Outros proxies usam este nome para a mesma coisa. */
  const verdadeiro = req.headers.get("true-client-ip");
  if (verdadeiro?.trim()) return verdadeiro.trim();

  /* Sem proxy conhecido, o primeiro da cadeia é o cliente. */
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const primeiro = fwd.split(",")[0]?.trim();
    if (primeiro) return primeiro;
  }

  return req.headers.get("x-real-ip")?.trim() || undefined;
}
