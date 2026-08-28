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
   * Esquecer uma rota de ingestão aqui NÃO dá erro: o middleware devolve um
   * 307 para /entrar, e quem chamou vê 405 ou uma página de login em vez da
   * resposta. Do lado do gateway isso é venda perdida em silêncio. Rota nova
   * de ingestão entra nesta lista no mesmo commit em que nasce.
   */
  matcher: [
    "/((?!api/collect|api/webhook|api/pedidos|api/claim|api/auth|rr/|rr\.js|_next|favicon).*)",
  ],
};
