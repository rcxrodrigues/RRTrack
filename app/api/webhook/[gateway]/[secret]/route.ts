/*
 * Roteador de webhook, um endereço por conexão de gateway.
 *
 *   /api/webhook/pagou/<segredo>
 *
 * Casca fina: o caminho inteiro vive em src/core/receber.ts, compartilhado com
 * a entrada por API. Duas cópias divergiriam, e a divergência apareceria como
 * venda que entra por uma porta e não pela outra, sem erro nenhum acusando.
 */

import { receberVenda } from "@/core/receber";

export const runtime = "nodejs";

type Params = { params: Promise<{ gateway: string; secret: string }> };

export async function POST(req: Request, { params }: Params): Promise<Response> {
  const { gateway, secret } = await params;
  return receberVenda(req, gateway, secret);
}
