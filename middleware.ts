import { NextResponse, type NextRequest } from "next/server";
import { COOKIE } from "@/core/auth";

/*
 * Porteiro do painel.
 *
 * Confere apenas a PRESENÇA do cookie, não a validade. Validar aqui exigiria
 * ir ao banco em toda navegação, inclusive de arquivo estático — caro e
 * desnecessário, porque a página valida de verdade antes de mostrar qualquer
 * dado. O papel do middleware é só evitar que quem não tem sessão nenhuma
 * carregue o painel para ver uma tela vazia.
 */
export function middleware(req: NextRequest) {
  const temCookie = !!req.cookies.get(COOKIE)?.value;
  const ehEntrar = req.nextUrl.pathname === "/entrar";

  if (!temCookie && !ehEntrar) {
    const url = req.nextUrl.clone();
    url.pathname = "/entrar";
    /* Guarda para onde a pessoa queria ir, e devolve depois de entrar. */
    if (req.nextUrl.pathname !== "/") url.searchParams.set("de", req.nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  if (temCookie && ehEntrar) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  /*
   * Fora do porteiro: as rotas de ingestão, que são autenticadas por chave
   * própria e precisam responder a quem não tem sessão nenhuma — o navegador
   * do visitante e o servidor do gateway.
   *
   * O retorno do Facebook e as páginas de /vincular entram pelo mesmo motivo:
   * quem autoriza em navegador antidetect não tem sessão do painel, e um
   * desvio para /entrar ali interromperia o vínculo no meio. A credencial
   * deles é o segredo da URL, conferido contra a tabela meta_links.
   *
   * Esquecer uma rota de ingestão aqui NÃO dá erro: o middleware devolve um
   * 307 para /entrar, e quem chamou vê 405 ou uma página de login em vez da
   * resposta. Do lado do gateway isso é venda perdida em silêncio. Rota nova
   * de ingestão entra nesta lista no mesmo commit em que nasce.
   *
   * Arquivo estático também fica de fora, e por um motivo que não é óbvio: o
   * navegador pede o favicon e a logo ANTES de qualquer sessão existir — na
   * própria tela de login, inclusive. Passando pelo porteiro, eles voltavam
   * 307 para /entrar e a imagem simplesmente não aparecia, sem erro nenhum
   * no console que dissesse por quê.
   */
  matcher: [
    "/((?!api/collect|api/webhook|api/pedidos|api/claim|api/auth|api/meta/retorno|vincular/|rr/|rr\.js|marca/|icon\.png|apple-icon|_next|favicon).*)",
  ],
};
