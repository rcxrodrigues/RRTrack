/*
 * Entrada por API, autenticada por token.
 *
 *   POST /api/pedidos
 *   Authorization: Bearer rrt_...     (ou)     x-api-token: rrt_...
 *
 * É o mesmo caminho de /api/pedidos/<segredo>, com o segredo saindo da URL e
 * indo para o cabeçalho — que é onde token de API mora.
 *
 * A diferença não é estética. Segredo em caminho de URL vaza por onde URL
 * passa: log de servidor, log de proxy, cabeçalho `Referer`, histórico de
 * navegador, mensagem de erro colada num chamado de suporte. Cabeçalho de
 * autorização não aparece em nenhum desses lugares por acidente.
 *
 * `x-api-token` é o cabeçalho da Utmify. Aceitá-lo é o que permite a quem já
 * integrou com eles apontar a URL para cá e não mexer em mais nada — o leitor
 * de payload em gateways/generico.ts entende o formato deles inteiro.
 *
 * A rota com o segredo no caminho continua valendo: quem já configurou não
 * pode parar de entregar venda porque a gente mudou de ideia sobre estilo.
 */

import { receberVenda } from "@/core/receber";
import { getGateway } from "@/gateways/registry";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  /*
   * Dois cabeçalhos, e `x-api-token` primeiro: quem manda os dois está
   * migrando de lá para cá, e é o token deles que vale.
   */
  const doPadrao = req.headers.get("authorization") ?? "";
  const daUtmify = req.headers.get("x-api-token") ?? "";

  /*
   * Aceita "Bearer rrt_x" e "rrt_x" pelado. A segunda forma existe porque
   * metade dos clientes de HTTP que um lojista usa manda o valor cru, e
   * recusar por causa de uma palavra vira uma tarde de depuração para
   * descobrir que faltava escrever "Bearer".
   */
  const token = daUtmify.trim() || (
    /^bearer\s+/i.test(doPadrao)
      ? doPadrao.replace(/^bearer\s+/i, "").trim()
      : doPadrao.trim()
  );

  if (!token) {
    return Response.json(
      { erro: "falta o token da credencial, em Authorization: Bearer ou x-api-token" },
      { status: 401 },
    );
  }

  /*
   * `isTest` valida sem gravar, como na Utmify.
   *
   * Serve para o desenvolvedor conferir o formato antes de ligar de verdade —
   * e é justamente quando o payload está errado que ele mais precisa de uma
   * resposta que diga O QUE está errado. Sem isto, a única forma de testar era
   * inserir venda de mentira no painel e depois caçá-la para apagar.
   *
   * A validação usa o MESMO leitor da entrada real. Um teste que passasse por
   * outro caminho aprovaria payload que a produção recusa, que é pior que não
   * ter teste nenhum.
   */
  let corpo: unknown;
  const cru = await req.text();
  try {
    corpo = JSON.parse(cru);
  } catch {
    return Response.json({ erro: "corpo não é JSON válido" }, { status: 400 });
  }

  const ehTeste = !!(corpo && typeof corpo === "object"
    && ((corpo as Record<string, unknown>).isTest === true
      || (corpo as Record<string, unknown>).teste === true));

  if (ehTeste) {
    const adaptador = getGateway("api")!;
    const lido = await adaptador.parse({ headers: {}, rawBody: cru, query: {} });

    if (!lido) {
      return Response.json({
        ok: false,
        erro: "não deu para ler uma venda deste corpo",
        dica: "confira `orderId`/`pedido_id` e `status` — sem os dois não há venda",
      }, { status: 400 });
    }

    /*
     * Devolve o que ENTENDEU, e não um "ok". O erro que este caminho existe
     * para pegar é o silencioso: valor lido cem vezes maior, data no dia
     * errado, comprador vazio. Um "ok" esconderia os três.
     */
    return Response.json({
      ok: true,
      teste: true,
      gravado: false,
      entendido: {
        pedido: lido.gatewayOrderId,
        status: lido.status,
        moeda: lido.currency,
        valorCents: lido.grossCents,
        taxaCents: lido.feeCents ?? null,
        metodo: lido.paymentMethod,
        quando: lido.occurredAt.toISOString(),
        itens: lido.items.length,
        comprador: Object.fromEntries(
          Object.entries(lido.customer ?? {}).map(([k, v]) => [k, v ? "ok" : null]),
        ),
        repasse: Object.keys(lido.passthrough),
      },
    });
  }

  /*
   * O corpo já foi lido, e `Request` só se lê uma vez. Reconstrói com o texto
   * cru — e é o texto CRU, não o objeto reserializado: assinatura de webhook
   * se calcula sobre os bytes originais, e reserializar quebraria qualquer
   * verificação que venha a existir neste caminho.
   */
  return receberVenda(
    new Request(req.url, { method: "POST", headers: req.headers, body: cru }),
    "api",
    token,
  );
}
