import "./globals.css";
import type { Metadata, Viewport } from "next";

/*
 * O ícone não é declarado aqui: o Next monta as tags a partir de `app/icon.png`
 * e `app/apple-icon.png`, pelo nome do arquivo. São dois arquivos e não um
 * porque o iPhone ignora o favicon comum — sem `apple-icon`, o atalho na tela
 * inicial vira um quadrado com a inicial do site desenhada pelo Safari.
 *
 * Os dois têm fundo sólido, e não transparente, porque o iOS compõe o que
 * sobrar sobre preto e o resultado parece recorte malfeito. O fundo é o mesmo
 * do painel, para o atalho parecer a mesma coisa que ele abre.
 */
export const metadata: Metadata = {
  title: "RRTrack",
  description: "Rastreamento e atribuição",

  /*
   * Aberto pelo atalho, roda em tela cheia, sem a barra do Safari — que é o
   * que faz parecer aplicativo e não página salva. O título curto é o nome
   * que aparece embaixo do ícone; sem ele, o iOS usa o título da página, que
   * muda de tela para tela.
   */
  appleWebApp: {
    capable: true,
    title: "RRTrack",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  /* Acompanha o tema do aparelho na barra de status. */
  themeColor: "#0B1014",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
