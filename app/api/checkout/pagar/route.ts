/*
 * A rota que cobra.
 *
 * Fina de propósito: lê o corpo, descobre o IP e entrega para `pagar`. Toda
 * regra — preço, limite de tentativas, validação, atribuição — vive em
 * `src/checkout/index.ts`, porque é lá que ela pode ser testada sem subir um
 * servidor.
 *
 * Sem CORS. As outras rotas públicas (`/api/collect`, `/api/claim`) precisam
 * atender o site do lojista de outro domínio; esta é chamada pela nossa própria
 * página, no nosso próprio domínio. Não liberar origem cruzada aqui é de graça
 * e tira uma superfície inteira de abuso.
 */

import { pagar } from "@/checkout/index";
import type { PedidoDoNavegador } from "@/checkout/index";

export const runtime = "nodejs";

function ipDoCliente(req: Request): string {
  /* Atrás de proxy, o IP real é o primeiro da cadeia do x-forwarded-for. */
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const primeiro = fwd.split(",")[0]?.trim();
    if (primeiro) return primeiro;
  }
  return req.headers.get("x-real-ip") ?? "0.0.0.0";
}

export async function POST(req: Request): Promise<Response> {
  let corpo: PedidoDoNavegador;
  try {
    corpo = JSON.parse(await req.text()) as PedidoDoNavegador;
  } catch {
    return Response.json({ ok: false, tipo: "invalido", motivo: "Corpo inválido." }, { status: 400 });
  }

  if (!corpo || typeof corpo.slug !== "string" || !corpo.comprador) {
    return Response.json({ ok: false, tipo: "invalido", motivo: "Dados incompletos." }, { status: 400 });
  }

  const resposta = await pagar(corpo, ipDoCliente(req));

  /*
   * Recusa e limite não são erro nosso: devolvem 200 com `ok: false` para o
   * formulário mostrar o motivo sem o navegador tratar como falha de rede.
   * Só entrada malformada vira 4xx.
   */
  const status = !resposta.ok && resposta.tipo === "invalido" ? 400 : 200;

  return Response.json(resposta, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
