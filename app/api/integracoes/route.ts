/*
 * Grava as integrações de uma loja: contas de anúncio, gateways e pixels.
 *
 * Uma rota só para os três porque a diferença entre eles é qual tabela recebe,
 * não o que precisa acontecer antes: confirmar sessão, confirmar que a pessoa
 * tem acesso àquela loja, cifrar segredo. Espalhar isso por três rotas é como
 * uma delas acaba esquecendo a confirmação de acesso.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { adAccounts, destinations, gatewayConnections } from "@/db/schema";
import { exigirSessao } from "@/core/sessao";
import { acessoALoja } from "@/core/auth";
import { encryptValue } from "@/core/crypto";
import { getGateway } from "@/gateways/registry";

export const runtime = "nodejs";

const PLATAFORMAS_ANUNCIO = ["meta", "google", "kwai", "tiktok", "taboola"];
const PLATAFORMAS_PIXEL = ["meta", "google", "kwai", "tiktok", "taboola"];

function texto(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

const aleatorio = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");

export async function POST(req: Request): Promise<Response> {
  const sessao = await exigirSessao();
  if (!sessao.ok) return sessao.resposta;

  const corpo = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const tenantId = texto(corpo.tenantId);
  if (!tenantId) return Response.json({ erro: "loja não informada" }, { status: 400 });

  /*
   * O pedido diz qual loja, mas quem confirma é o banco. Sem esta linha,
   * bastaria trocar o id no corpo da requisição para escrever na loja de
   * outra conta.
   */
  const loja = await acessoALoja(sessao.ctx.usuario.userId, tenantId);
  if (!loja) return Response.json({ erro: "não encontrado" }, { status: 404 });

  const tipo = texto(corpo.tipo);

  try {
    switch (tipo) {
      /* ------------------------------------------------ conta de anúncio */
      case "conta_anuncio": {
        const plataforma = texto(corpo.plataforma);
        const externalId = texto(corpo.externalId);
        if (!plataforma || !PLATAFORMAS_ANUNCIO.includes(plataforma) || !externalId) {
          return Response.json({ erro: "plataforma e id da conta são obrigatórios" }, { status: 400 });
        }

        const cred: Record<string, string> = {};
        for (const chave of ["accessToken", "refreshToken", "developerToken", "clientId", "clientSecret", "loginCustomerId"]) {
          const v = texto(corpo[chave]);
          if (v) cred[chave] = await encryptValue(v);
        }

        const [existente] = await db.select({ id: adAccounts.id }).from(adAccounts)
          .where(and(
            eq(adAccounts.tenantId, tenantId),
            eq(adAccounts.platform, plataforma),
            eq(adAccounts.externalId, externalId),
          )).limit(1);

        if (existente) {
          await db.update(adAccounts).set({
            label: texto(corpo.label) ?? plataforma,
            /* Credencial vazia não apaga a que já existe: quem só renomeou a
               conta não deveria perder o token por causa disso. */
            ...(Object.keys(cred).length ? { credentials: cred } : {}),
            active: corpo.active !== false,
          }).where(eq(adAccounts.id, existente.id));
          return Response.json({ ok: true, id: existente.id, novo: false });
        }

        const [nova] = await db.insert(adAccounts).values({
          tenantId, platform: plataforma, externalId,
          label: texto(corpo.label) ?? plataforma,
          credentials: cred, active: true,
        }).returning({ id: adAccounts.id });

        return Response.json({ ok: true, id: nova!.id, novo: true });
      }

      /* ------------------------------------------------------- gateway */
      case "gateway": {
        const gateway = texto(corpo.gateway);
        if (!gateway || !getGateway(gateway)) {
          return Response.json({ erro: "gateway desconhecido" }, { status: 400 });
        }

        const cred: Record<string, string> = {};
        for (const chave of ["apiKey", "apiSecret", "clientId", "clientSecret", "publicKey", "secretKey"]) {
          const v = texto(corpo[chave]);
          if (v) cred[chave] = await encryptValue(v);
        }

        const [existente] = await db.select({ id: gatewayConnections.id, segredo: gatewayConnections.webhookSecret })
          .from(gatewayConnections)
          .where(and(eq(gatewayConnections.tenantId, tenantId), eq(gatewayConnections.gateway, gateway)))
          .limit(1);

        if (existente) {
          await db.update(gatewayConnections).set({
            label: texto(corpo.label) ?? gateway,
            ...(Object.keys(cred).length ? { credentials: cred } : {}),
            active: corpo.active !== false,
          }).where(eq(gatewayConnections.id, existente.id));
          /* O segredo do webhook NUNCA é regerado numa edição: trocá-lo
             invalidaria a URL já configurada no painel do gateway, e as vendas
             parariam de chegar sem nenhum erro visível. */
          return Response.json({ ok: true, id: existente.id, segredo: existente.segredo, novo: false });
        }

        const segredo = "whsec_" + aleatorio(24);
        const [nova] = await db.insert(gatewayConnections).values({
          tenantId, gateway,
          label: texto(corpo.label) ?? gateway,
          credentials: cred, webhookSecret: segredo, active: true,
        }).returning({ id: gatewayConnections.id });

        return Response.json({ ok: true, id: nova!.id, segredo, novo: true });
      }

      /* --------------------------------------------------------- pixel */
      case "pixel": {
        const plataforma = texto(corpo.plataforma);
        const externalId = texto(corpo.externalId);
        const token = texto(corpo.token);

        if (!plataforma || !PLATAFORMAS_PIXEL.includes(plataforma) || !externalId) {
          return Response.json({ erro: "plataforma e id do pixel são obrigatórios" }, { status: 400 });
        }

        const config: Record<string, unknown> = {};
        if (Array.isArray(corpo.eventos)) config.eventos = corpo.eventos;
        if (texto(corpo.textoBotaoCheckout)) config.textoBotaoCheckout = texto(corpo.textoBotaoCheckout);

        const [existente] = await db.select({ id: destinations.id }).from(destinations)
          .where(and(
            eq(destinations.tenantId, tenantId),
            eq(destinations.platform, plataforma),
            eq(destinations.externalId, externalId),
          )).limit(1);

        /*
         * O Google não usa um token só: precisa de OAuth2 completo, do
         * developer token que ele mesmo aprova, e do nome do recurso da ação
         * de conversão. Cada plataforma guarda o que a dela exige.
         */
        const credenciais: Record<string, string> = {};
        if (token) credenciais.accessToken = await encryptValue(token);
        for (const chave of ["developerToken", "clientId", "clientSecret", "refreshToken", "loginCustomerId", "conversionAction"]) {
          const v = texto(corpo[chave]);
          if (v) credenciais[chave] = await encryptValue(v);
        }
        const temCredencial = Object.keys(credenciais).length > 0;

        if (existente) {
          await db.update(destinations).set({
            label: texto(corpo.label) ?? `Pixel ${plataforma}`,
            ...(temCredencial ? { credentials: credenciais } : {}),
            config,
            active: corpo.active !== false,
          }).where(eq(destinations.id, existente.id));

          /* Só toca no código de teste quando veio valor. Apagá-lo em silêncio
             faria os eventos sumirem da aba de teste sem nada parar de
             funcionar — a pior forma de quebrar. */
          const teste = texto(corpo.testEventCode);
          if (teste) {
            await db.update(destinations).set({ testEventCode: teste })
              .where(eq(destinations.id, existente.id));
          }
          return Response.json({ ok: true, id: existente.id, novo: false });
        }

        if (!temCredencial) {
          return Response.json({ erro: "credencial é obrigatória para criar" }, { status: 400 });
        }

        const [nova] = await db.insert(destinations).values({
          tenantId, platform: plataforma, externalId,
          label: texto(corpo.label) ?? `Pixel ${plataforma}`,
          credentials: credenciais,
          config,
          testEventCode: texto(corpo.testEventCode) ?? null,
          active: true,
        }).returning({ id: destinations.id });

        return Response.json({ ok: true, id: nova!.id, novo: true });
      }

      default:
        return Response.json({ erro: "tipo inválido" }, { status: 400 });
    }
  } catch (e) {
    return Response.json(
      { erro: e instanceof Error ? e.message : "falha ao gravar" },
      { status: 500 },
    );
  }
}

/* Desativa uma integração. Não apaga: o histórico de disparos aponta para ela. */
export async function DELETE(req: Request): Promise<Response> {
  const sessao = await exigirSessao();
  if (!sessao.ok) return sessao.resposta;

  const url = new URL(req.url);
  const tenantId = url.searchParams.get("tenantId");
  const tipo = url.searchParams.get("tipo");
  const id = url.searchParams.get("id");

  if (!tenantId || !tipo || !id) {
    return Response.json({ erro: "parâmetros faltando" }, { status: 400 });
  }

  const loja = await acessoALoja(sessao.ctx.usuario.userId, tenantId);
  if (!loja) return Response.json({ erro: "não encontrado" }, { status: 404 });

  const tabela = tipo === "conta_anuncio" ? adAccounts
    : tipo === "gateway" ? gatewayConnections
    : tipo === "pixel" ? destinations : null;

  if (!tabela) return Response.json({ erro: "tipo inválido" }, { status: 400 });

  await db.update(tabela).set({ active: false })
    .where(and(eq(tabela.id, id), eq(tabela.tenantId, tenantId)));

  return Response.json({ ok: true });
}
