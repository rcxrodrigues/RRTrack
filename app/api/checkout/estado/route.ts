/*
 * "Já caiu?" — a pergunta da tela do pix.
 *
 * O comprador copia o código, paga no banco e volta para a aba. Nada avisa a
 * página: quem sabe do pagamento é o webhook da Appmax, que chega ao servidor
 * segundos depois. Esta rota existe para a página perguntar até a resposta
 * mudar.
 *
 * Não devolve valor, nem comprador, nem nada além do estado. O id do pedido
 * viaja na URL e qualquer um que o tenha poderia consultar — então o que ela
 * responde precisa ser inútil para quem não é o dono.
 */

import { estadoDoPedido } from "@/checkout/index";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const slug = (url.searchParams.get("checkout") ?? "").trim();
  const pedido = (url.searchParams.get("pedido") ?? "").trim();

  if (!slug || !pedido) {
    return Response.json({ erro: "parâmetros ausentes" }, { status: 400 });
  }

  return Response.json(
    { estado: await estadoDoPedido(slug, pedido) },
    { headers: { "cache-control": "no-store" } },
  );
}
