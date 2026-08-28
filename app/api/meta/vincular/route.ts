/*
 * Passo 3 de 3: lista o que o perfil autorizado enxerga, e grava o escolhido.
 *
 * GET  devolve contas de anúncio e pixels — nunca o token.
 * POST grava as escolhas e descarta o token do cookie.
 *
 * O mesmo token vai para as duas tabelas, `ad_accounts` e `destinations`,
 * porque é o mesmo perfil que lê o gasto e envia a conversão. Duplicar parece
 * desperdício, mas é o formato que o resto do sistema já espera: cada linha
 * carrega a própria credencial, e desvincular uma conta não pode derrubar o
 * envio de evento de outra.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { adAccounts, destinations } from "@/db/schema";
import { exigirSessao } from "@/core/sessao";
import { acessoALoja } from "@/core/auth";
import { encryptValue } from "@/core/crypto";
import { contasEPixels } from "@/ads/meta-oauth";
import { appDaMeta, esquecerToken, lerToken } from "@/ads/meta-vinculo";

export const runtime = "nodejs";

/*
 * Confere as três coisas que precisam valer juntas: há sessão, há um vínculo
 * em andamento, e a loja do vínculo é uma que esta pessoa acessa. A terceira é
 * a que importa — sem ela, quem tem uma sessão qualquer poderia gravar o token
 * numa loja alheia trocando o tenantId do corpo.
 */
async function contextoDoVinculo(tenantIdPedido?: string) {
  const sessao = await exigirSessao();
  if (!sessao.ok) return { erro: sessao.resposta };

  const vinculo = await lerToken();
  if (!vinculo) {
    return {
      erro: Response.json(
        { erro: "nenhuma conexão em andamento — conecte com o Facebook de novo" },
        { status: 409 },
      ),
    };
  }

  if (tenantIdPedido && tenantIdPedido !== vinculo.tenantId) {
    return { erro: Response.json({ erro: "loja não confere" }, { status: 400 }) };
  }

  const loja = await acessoALoja(sessao.ctx.usuario.userId, vinculo.tenantId);
  if (!loja) return { erro: Response.json({ erro: "não encontrado" }, { status: 404 }) };

  const app = appDaMeta();
  if (!app) {
    return { erro: Response.json({ erro: "app da Meta não configurado" }, { status: 503 }) };
  }

  return { vinculo, app, loja };
}

export async function GET(): Promise<Response> {
  const ctx = await contextoDoVinculo();
  if (ctx.erro) return ctx.erro;

  try {
    const { contas, pixels } = await contasEPixels(ctx.app, ctx.vinculo.token);
    return Response.json({
      loja: { id: ctx.loja.id, nome: ctx.loja.nome },
      expiraEm: ctx.vinculo.expiraEm,
      contas,
      pixels,
    });
  } catch (e) {
    return Response.json(
      { erro: e instanceof Error ? e.message : "falha ao listar" },
      { status: 502 },
    );
  }
}

interface Escolha {
  id: string;
  label: string;
}

function escolhas(v: unknown): Escolha[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is Escolha =>
      !!x && typeof x === "object"
      && typeof (x as Escolha).id === "string" && (x as Escolha).id.trim() !== "")
    .map((x) => ({ id: x.id.trim(), label: (x.label ?? "").trim() || x.id.trim() }));
}

export async function POST(req: Request): Promise<Response> {
  const corpo = await req.json().catch(() => ({}));

  const ctx = await contextoDoVinculo(
    typeof corpo.tenantId === "string" ? corpo.tenantId : undefined,
  );
  if (ctx.erro) return ctx.erro;

  const contas = escolhas(corpo.contas);
  const pixels = escolhas(corpo.pixels);

  if (contas.length === 0 && pixels.length === 0) {
    return Response.json({ erro: "escolha ao menos uma conta ou um pixel" }, { status: 400 });
  }

  const tenantId = ctx.vinculo.tenantId;
  const cifrado = { accessToken: await encryptValue(ctx.vinculo.token) };
  const vence = ctx.vinculo.expiraEm ? new Date(ctx.vinculo.expiraEm) : null;

  for (const c of contas) {
    const [existente] = await db.select({ id: adAccounts.id }).from(adAccounts)
      .where(and(
        eq(adAccounts.tenantId, tenantId),
        eq(adAccounts.platform, "meta"),
        eq(adAccounts.externalId, c.id),
      )).limit(1);

    if (existente) {
      /*
       * Reconectar é o caminho normal quando o token de 60 dias vence, e a
       * pessoa não deveria perder o nome que deu à conta por causa disso.
       */
      await db.update(adAccounts)
        .set({ credentials: cifrado, credentialsExpireAt: vence, active: true })
        .where(eq(adAccounts.id, existente.id));
    } else {
      await db.insert(adAccounts).values({
        tenantId, platform: "meta", externalId: c.id, label: c.label,
        credentials: cifrado, credentialsExpireAt: vence, active: true,
      });
    }
  }

  for (const p of pixels) {
    const [existente] = await db.select({ id: destinations.id }).from(destinations)
      .where(and(
        eq(destinations.tenantId, tenantId),
        eq(destinations.platform, "meta"),
        eq(destinations.externalId, p.id),
      )).limit(1);

    if (existente) {
      await db.update(destinations)
        .set({ credentials: cifrado, active: true })
        .where(eq(destinations.id, existente.id));
    } else {
      await db.insert(destinations).values({
        tenantId, platform: "meta", externalId: p.id, label: p.label,
        credentials: cifrado, config: {}, active: true,
      });
    }
  }

  await esquecerToken();

  return Response.json({ ok: true, contas: contas.length, pixels: pixels.length });
}
