/*
 * Entrada por API: a venda empurrada por quem não tem adaptador.
 *
 *   POST /api/pedidos/<segredo>
 *
 * É o gateway "api" do registro, servido num endereço que diz o que é. Mesmo
 * caminho do webhook, de propósito: a venda empurrada passa pelas mesmas regras
 * de atribuição, custo, ordem de estados e disparo.
 *
 * O segredo no caminho é a única barreira — quem o tiver insere venda e dispara
 * conversão. Ele vive no servidor da loja, nunca em código de navegador.
 */

import { receberVenda } from "@/core/receber";

export const runtime = "nodejs";

type Params = { params: Promise<{ secret: string }> };

export async function POST(req: Request, { params }: Params): Promise<Response> {
  const { secret } = await params;
  return receberVenda(req, "api", secret);
}
