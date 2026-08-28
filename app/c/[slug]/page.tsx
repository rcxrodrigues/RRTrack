/*
 * A página pública do checkout: /c/{slug}.
 *
 * Fora do grupo (painel) de propósito — não tem barra lateral, não pede login,
 * e quem abre não é o lojista, é quem vai pagar.
 *
 * O clickId chega pela URL. O `decorate` do rr.js carimba `sck` em todo link
 * de checkout do site do lojista, então o link para cá já vem com ele sem
 * ninguém precisar fazer nada. Repassamos esse valor ao rr.js desta página via
 * `RRTrackConfig.clickId`: sem isso ela abriria uma sessão nova, e a venda
 * ficaria atribuída ao clique na própria página de pagamento em vez do anúncio
 * que trouxe a pessoa até aqui.
 */

import { notFound } from "next/navigation";
import { checkoutPorSlug, totalDoCheckout } from "@/checkout/index";
import { Checkout } from "@/ui/checkout";

export const runtime = "nodejs";
/* Oferta e preço mudam no painel e precisam valer na hora. */
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Busca = Record<string, string | string[] | undefined>;

/* `sck` é o nome que o rr.js usa; os outros são cortesia para link montado à mão. */
function clickIdDaUrl(busca: Busca): string | undefined {
  for (const chave of ["sck", "cid", "click_id"]) {
    const v = busca[chave];
    const s = Array.isArray(v) ? v[0] : v;
    if (s && UUID_RE.test(s)) return s;
  }
  return undefined;
}

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const checkout = await checkoutPorSlug(slug);
  return {
    title: checkout ? `${checkout.name} — Pagamento` : "Checkout",
    /* Página de pagamento não tem por que aparecer em busca. */
    robots: { index: false, follow: false },
  };
}

export default async function PaginaCheckout(
  { params, searchParams }: {
    params: Promise<{ slug: string }>;
    searchParams: Promise<Busca>;
  },
) {
  const { slug } = await params;
  const checkout = await checkoutPorSlug(slug);
  if (!checkout) notFound();

  const clickId = clickIdDaUrl(await searchParams);
  const totais = totalDoCheckout(checkout);

  /*
   * O rr.js só entra se o checkout estiver ligado a um site. Sem isso ele
   * avisaria "siteKey ausente" no console e não coletaria nada — melhor não
   * carregar do que carregar quebrado.
   */
  const rastreio = checkout.siteKey
    ? `window.RRTrackConfig=${JSON.stringify({
        siteKey: checkout.siteKey,
        endpoint: "/rr/collect",
        ...(clickId ? { clickId } : {}),
      })}`
    : null;

  return (
    <>
      {rastreio && (
        <>
          <script dangerouslySetInnerHTML={{ __html: rastreio }} />
          <script src="/rr.js" async />
        </>
      )}
      <Checkout checkout={checkout} clickIdUrl={clickId} totais={totais} />
    </>
  );
}
