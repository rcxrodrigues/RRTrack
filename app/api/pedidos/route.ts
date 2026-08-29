/*
 * Entrada por API, autenticada por token.
 *
 *   POST /api/pedidos
 *   Authorization: Bearer rrt_...
 *
 * É o mesmo caminho de /api/pedidos/<segredo>, com o segredo saindo da URL e
 * indo para o cabeçalho — que é onde token de API mora.
 *
 * A diferença não é estética. Segredo em caminho de URL vaza por onde URL
 * passa: log de servidor, log de proxy, cabeçalho `Referer`, histórico de
 * navegador, mensagem de erro colada num chamado de suporte. Cabeçalho de
 * autorização não aparece em nenhum desses lugares por acidente.
 *
 * A rota com o segredo no caminho continua valendo: quem já configurou não
 * pode parar de entregar venda porque a gente mudou de ideia sobre estilo.
 */

import { receberVenda } from "@/core/receber";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const cabecalho = req.headers.get("authorization") ?? "";

  /*
   * Aceita "Bearer rrt_x" e "rrt_x" pelado. A segunda forma existe porque
   * metade dos clientes de HTTP que um lojista usa manda o valor cru, e
   * recusar por causa de uma palavra vira uma tarde de depuração para
   * descobrir que faltava escrever "Bearer".
   */
  const token = /^bearer\s+/i.test(cabecalho)
    ? cabecalho.replace(/^bearer\s+/i, "").trim()
    : cabecalho.trim();

  if (!token) {
    return Response.json(
      { erro: "falta o cabeçalho Authorization com o token da credencial" },
      { status: 401 },
    );
  }

  return receberVenda(req, "api", token);
}
