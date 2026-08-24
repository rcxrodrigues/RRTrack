/*
 * Entrada por API: a venda empurrada por quem não tem adaptador.
 *
 *   POST /api/pedidos/<segredo>
 *
 * É um endereço melhor para o que já existia — o gateway "api" no roteador de
 * webhook — e não uma implementação paralela. Chamar o mesmo handler é
 * deliberado: a venda empurrada tem de passar pelas mesmas regras de
 * atribuição, custo, ordem de estados e disparo. Duas rotas com dois códigos
 * divergiriam, e a divergência apareceria como venda que entra por um caminho
 * e não pelo outro, sem erro nenhum acusando.
 *
 * O segredo no caminho é a única barreira: quem o tiver insere venda e dispara
 * conversão. Ele vive no servidor da loja, nunca em código de navegador.
 */

import { POST as receberWebhook } from "../../webhook/[gateway]/[secret]/route";

export const runtime = "nodejs";

type Params = { params: Promise<{ secret: string }> };

export async function POST(req: Request, { params }: Params): Promise<Response> {
  const { secret } = await params;
  return receberWebhook(req, {
    params: Promise.resolve({ gateway: "api", secret }),
  });
}
