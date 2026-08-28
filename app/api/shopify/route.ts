/*
 * Ligar, desligar e consultar a loja da Shopify — só para quem está logado.
 *
 * O token da Admin API entra por aqui e nunca mais sai: é cifrado na gravação e
 * o painel só recebe de volta o domínio e o nome da loja. Rota que devolvesse a
 * credencial para a tela colocaria no navegador de cada sessão aberta uma chave
 * que cria pedidos e lê o cadastro inteiro de clientes.
 */

import { exigirSessao } from "@/core/sessao";
import { acessoALoja } from "@/core/auth";
import {
  conectarShopify, desconectarShopify, listarConexoesShopify,
  listarProdutosShopify, pedidosDoCheckout, sincronizarPedidoShopify,
} from "@/checkout/shopify";

export const runtime = "nodejs";

/** Toda rota daqui exige sessão válida e acesso à loja informada. */
async function porteiro(tenantId: string): Promise<Response | { userId: string }> {
  const sessao = await exigirSessao();
  if (!sessao.ok) return sessao.resposta;

  if (!tenantId) return Response.json({ erro: "loja não informada" }, { status: 400 });

  const loja = await acessoALoja(sessao.ctx.usuario.userId, tenantId);
  if (!loja) return Response.json({ erro: "não encontrado" }, { status: 404 });

  return { userId: sessao.ctx.usuario.userId };
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const tenantId = url.searchParams.get("tenantId") ?? "";

  const guarda = await porteiro(tenantId);
  if (guarda instanceof Response) return guarda;

  /*
   * O catálogo passa por aqui em vez de o navegador falar com a Shopify.
   *
   * Não é rodeio: o token é do servidor e assim continua. Um pedido de produtos
   * feito pelo navegador exigiria entregar a credencial para a tela, e ela lê
   * cliente e cria pedido — muito mais do que listar produto precisa.
   */
  const conexaoId = url.searchParams.get("conexaoId");
  if (conexaoId) {
    const r = await listarProdutosShopify(
      tenantId, conexaoId,
      url.searchParams.get("busca") ?? undefined,
      url.searchParams.get("cursor") ?? undefined,
    );
    if (!r.ok) return Response.json({ erro: r.erro }, { status: 400 });
    return Response.json({ produtos: r.produtos, proximo: r.proximo });
  }

  if (url.searchParams.get("pedidos")) {
    return Response.json({ pedidos: await pedidosDoCheckout(tenantId) });
  }

  return Response.json({ conexoes: await listarConexoesShopify(tenantId) });
}

export async function POST(req: Request): Promise<Response> {
  const corpo = (await req.json().catch(() => ({}))) as {
    tenantId?: string;
    acao?: string;
    dominio?: string;
    token?: string;
    gatewayConnectionId?: string;
    gatewayOrderId?: string;
  };

  const guarda = await porteiro(corpo.tenantId ?? "");
  if (guarda instanceof Response) return guarda;

  /*
   * Reenvio manual do que falhou.
   *
   * A varredura automática desiste depois de oito tentativas, porque erro que
   * não é temporário não melhora sozinho — variante apagada, escopo faltando.
   * Depois de corrigir a causa, o lojista precisa de um jeito de dizer "agora
   * tenta de novo" sem esperar a próxima venda.
   */
  if (corpo.acao === "reenviar") {
    if (!corpo.gatewayConnectionId || !corpo.gatewayOrderId) {
      return Response.json({ erro: "pedido não informado" }, { status: 400 });
    }
    const r = await sincronizarPedidoShopify(corpo.gatewayConnectionId, corpo.gatewayOrderId);
    if (!r.ok) return Response.json({ erro: r.erro }, { status: 400 });
    return Response.json({ ok: true, pedido: r.nome });
  }

  const r = await conectarShopify(
    corpo.tenantId!, corpo.dominio ?? "", corpo.token ?? "",
  );
  if (!r.ok) return Response.json({ erro: r.erro }, { status: 400 });

  return Response.json({ ok: true, id: r.id, label: r.label });
}

export async function DELETE(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const tenantId = url.searchParams.get("tenantId") ?? "";
  const id = url.searchParams.get("id") ?? "";

  const guarda = await porteiro(tenantId);
  if (guarda instanceof Response) return guarda;

  if (!id) return Response.json({ erro: "conexão não informada" }, { status: 400 });

  const apagou = await desconectarShopify(tenantId, id);
  if (!apagou) return Response.json({ erro: "conexão não encontrada" }, { status: 404 });

  return Response.json({ ok: true });
}
