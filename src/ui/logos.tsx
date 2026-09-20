/*
 * As marcas das plataformas, desenhadas em SVG.
 *
 * Inline, e não arquivo de imagem, por três motivos: não some se o CDN cair,
 * não custa uma requisição por cartão, e acompanha o tamanho pedido sem
 * precisar de dois arquivos por densidade de tela.
 *
 * As cores são as oficiais e ficam fixas de propósito — não seguem o tema.
 * Logo de marca com a cor trocada deixa de ser reconhecível, que é a única
 * coisa que um logo precisa fazer.
 */

export function LogoMeta({ tamanho = 28 }: { tamanho?: number }) {
  return (
    <svg width={tamanho} height={tamanho} viewBox="0 0 40 40" aria-label="Meta Ads">
      <circle cx="20" cy="20" r="20" fill="#1877F2" />
      <path
        fill="#fff"
        d="M25.6 25.8l.9-5.8h-5.5v-3.8c0-1.6.8-3.1 3.3-3.1h2.5V8.1S24.5 7.7 22.3 7.7c-4.6 0-7.6 2.8-7.6 7.8V20h-5v5.8h5V40a20 20 0 0 0 6.3 0V25.8h4.6z"
      />
    </svg>
  );
}

export function LogoGoogleAds({ tamanho = 28 }: { tamanho?: number }) {
  return (
    <svg width={tamanho} height={tamanho} viewBox="0 0 40 40" aria-label="Google Ads">
      {/* Duas barras inclinadas e o círculo — a forma que o Google usa. */}
      <rect x="4" y="12" width="26" height="13" rx="6.5" fill="#FBBC04"
        transform="rotate(-60 17 18.5)" />
      <rect x="14" y="12" width="26" height="13" rx="6.5" fill="#4285F4"
        transform="rotate(60 27 18.5)" />
      <circle cx="10.5" cy="29.5" r="6.5" fill="#34A853" />
    </svg>
  );
}

export function LogoTikTok({ tamanho = 28 }: { tamanho?: number }) {
  return (
    <svg width={tamanho} height={tamanho} viewBox="0 0 40 40" aria-label="TikTok Ads">
      <rect width="40" height="40" rx="9" fill="#010101" />
      {/* A nota, em três camadas: ciano atrás, vermelho deslocado, branco na frente. */}
      <g transform="translate(8 8) scale(.6)">
        <path fill="#25F4EE"
          d="M14.5 16.4v-2a11 11 0 0 0-1.5-.1A11.1 11.1 0 0 0 6.6 34.2a11 11 0 0 1 8-18.7c.5 0 1 0 1.5.1v2.2a8.9 8.9 0 0 0-1.6-.1 8.9 8.9 0 0 0-2.3 17.5 8.9 8.9 0 0 1 2.3-18.8z" />
        <path fill="#FE2C55"
          d="M31.3 8.6a10.9 10.9 0 0 1-2.6-4.4h2.3a8.8 8.8 0 0 0 8.1 7.9v6.5a15.2 15.2 0 0 1-8.9-2.9v13.1a11.4 11.4 0 0 1-19.9 7.6 11.4 11.4 0 0 0 19.4-8V15.2a15.2 15.2 0 0 0 8.9 2.9v-2.2a8.8 8.8 0 0 1-7.3-7.3z" />
        <path fill="#fff"
          d="M30.2 15.5v13.3a11.4 11.4 0 0 1-19.4 8 11.4 11.4 0 0 1 3.7-19.7v6.8a5 5 0 1 0 3.5 4.8V0h6.5a8.8 8.8 0 0 0 .3 2.2 8.8 8.8 0 0 0 5.4 6.4 8.8 8.8 0 0 0 8 7.3v.5a15.2 15.2 0 0 1-8-.9z" />
      </g>
    </svg>
  );
}

export function LogoGA4({ tamanho = 28 }: { tamanho?: number }) {
  return (
    <svg width={tamanho} height={tamanho} viewBox="0 0 40 40" aria-label="Google Analytics 4">
      {/* As três barras em escada, que é a forma do Analytics. */}
      <rect x="27" y="4" width="9" height="32" rx="4.5" fill="#E37400" />
      <rect x="15.5" y="14" width="9" height="22" rx="4.5" fill="#F9AB00" />
      <circle cx="8.5" cy="31.5" r="4.5" fill="#F9AB00" />
    </svg>
  );
}

export function LogoPlataforma({ id, tamanho }: { id: string; tamanho?: number }) {
  if (id === "meta") return <LogoMeta tamanho={tamanho} />;
  if (id === "google") return <LogoGoogleAds tamanho={tamanho} />;
  if (id === "ga4") return <LogoGA4 tamanho={tamanho} />;
  /*
   * O TikTok é o último, e isso já foi um defeito esperando acontecer: era o
   * `else` de qualquer id desconhecido, então uma plataforma nova aparecia no
   * painel com a marca do TikTok — errado de um jeito que ninguém reporta como
   * bug, só estranha. Hoje cada id tem o seu; acrescentando um, acrescente a
   * linha aqui.
   */
  return <LogoTikTok tamanho={tamanho} />;
}
