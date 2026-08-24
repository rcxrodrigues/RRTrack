/*
 * Reivindicação de pedido — para gateways que não devolvem nada.
 *
 * A Appmax é o caso que obrigou a existir isto: o webhook de pedido dela não
 * tem campo de repasse, e o `tracking` que ela aceita fica no cliente, não no
 * pedido. Sem esta rota, toda venda por lá chegaria órfã por construção.
 *
 * O fluxo é simples e a loja já tem as duas pontas na mão: quando o servidor
 * dela cria o pedido no gateway, ele conhece o clickId (que o rr.js colocou no
 * carrinho) e recebe de volta o id do pedido. Uma chamada aqui registra o par,
 * e o webhook, quando chegar, encontra o dono.
 *
 * Vale para qualquer gateway sem repasse, não só a Appmax.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { clickSessions, orderClaims, sites } from "@/db/schema";
import { getGateway } from "@/gateways/registry";
import { encryptValue } from "@/core/crypto";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cors(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "origin",
  };
}

export async function OPTIONS(req: Request): Promise<Response> {
  return new Response(null, { status: 204, headers: cors(req.headers.get("origin")) });
}

export async function POST(req: Request): Promise<Response> {
  const headers = cors(req.headers.get("origin"));

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await req.text()) as Record<string, unknown>;
  } catch {
    return Response.json({ erro: "corpo inválido" }, { status: 400, headers });
  }

  const siteKey = typeof body.site_key === "string" ? body.site_key.trim() : "";
  const clickId = typeof body.click_id === "string" ? body.click_id.trim() : "";
  const gateway = typeof body.gateway === "string" ? body.gateway.trim() : "";
  const orderId = typeof body.gateway_order_id === "string"
    ? body.gateway_order_id.trim()
    : typeof body.gateway_order_id === "number"
      ? String(body.gateway_order_id) : "";

  if (!siteKey || !UUID_RE.test(clickId) || !gateway || !orderId) {
    return Response.json({ erro: "campos obrigatórios ausentes" }, { status: 400, headers });
  }

  if (!getGateway(gateway)) {
    return Response.json({ erro: "gateway desconhecido" }, { status: 400, headers });
  }

  const [site] = await db.select().from(sites).where(eq(sites.publicKey, siteKey)).limit(1);
  if (!site || !site.active) return Response.json({ erro: "site inválido" }, { status: 403, headers });

  /*
   * A sessão precisa existir e ser da mesma loja. Sem esta checagem, quem
   * tivesse a chave pública poderia amarrar pedidos a sessões de outra conta.
   */
  const [sessao] = await db
    .select({ id: clickSessions.clickId })
    .from(clickSessions)
    .where(and(eq(clickSessions.clickId, clickId), eq(clickSessions.tenantId, site.tenantId)))
    .limit(1);

  if (!sessao) return Response.json({ erro: "sessão desconhecida" }, { status: 404, headers });

  /*
   * Dados do comprador que a loja conhece e o gateway não devolve.
   *
   * Nenhum dos gateways integrados devolve endereço, e o CEP é o que destrava
   * `ct`, `st` e `zp` no CAPI — três chaves de correspondência. Mas o checkout
   * da loja já pediu o CEP para calcular frete, antes de o gateway entrar na
   * história. Aqui ela repassa o que já tem.
   *
   * Cifrado antes de encostar no banco: é dado pessoal, e um dump não deve
   * sair com o endereço dos seus compradores dentro.
   */
  const comprador: Record<string, string> = {};
  const bruto = (body.customer ?? {}) as Record<string, unknown>;
  for (const campo of ["name", "email", "phone", "document", "zip", "city", "state", "country", "birthdate", "gender"]) {
    const v = bruto[campo];
    if (typeof v === "string" && v.trim()) comprador[campo] = await encryptValue(v.trim());
  }
  const temComprador = Object.keys(comprador).length > 0;

  /*
   * A primeira reivindicação vence. Se chegasse uma segunda para o mesmo
   * pedido, seria ou repetição inofensiva ou tentativa de roubar a atribuição
   * de uma venda alheia — em nenhum dos dois casos vale sobrescrever.
   *
   * O comprador é a exceção: ele pode chegar depois, quando a loja só descobre
   * o CEP no passo seguinte do checkout. Completar não é roubar.
   */
  const [gravado] = await db.insert(orderClaims).values({
    tenantId: site.tenantId,
    gateway,
    gatewayOrderId: orderId,
    clickId,
    customer: temComprador ? comprador : null,
  }).onConflictDoNothing().returning({ id: orderClaims.id });

  if (!gravado && temComprador) {
    await db.update(orderClaims)
      .set({ customer: comprador })
      .where(and(
        eq(orderClaims.tenantId, site.tenantId),
        eq(orderClaims.gateway, gateway),
        eq(orderClaims.gatewayOrderId, orderId),
      ));
  }

  return Response.json({
    ok: true,
    novo: !!gravado,
    comprador: temComprador ? Object.keys(bruto).length : 0,
  }, { headers });
}
