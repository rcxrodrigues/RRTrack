/*
 * O que do perfil conectado pertence a esta loja.
 *
 * GET  lista contas e pixels que o perfil enxerga, marcando o que já está
 *      vinculado. Nunca devolve o token.
 * POST aplica a escolha: liga o que foi marcado, desliga o que foi desmarcado.
 *
 * Esta tela é revisitável de propósito. O login com o Facebook acontece uma
 * vez e fica guardado em `meta_profiles`; ligar uma conta nova no mês seguinte
 * não pode exigir refazer o consentimento inteiro. Enquanto o token valer, a
 * lista está a um clique.
 *
 * O token é copiado para cada linha de `ad_accounts` e `destinations` porque é
 * o formato que o resto do sistema espera — cada linha carrega a própria
 * credencial, e desvincular uma conta não derruba o envio de outra.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { adAccounts, destinations } from "@/db/schema";
import { contexto } from "@/core/sessao";
import { lojaAtual } from "@/core/loja-atual";
import { acessoALoja } from "@/core/auth";
import { encryptValue } from "@/core/crypto";
import { contasEPixels } from "@/ads/meta-oauth";
import { appDaMeta, perfilDaLoja } from "@/ads/meta-vinculo";

export const runtime = "nodejs";

async function contextoDaLoja(tenantIdPedido?: string) {
  const ctx = await contexto();
  if (!ctx) return { erro: Response.json({ erro: "não autenticado" }, { status: 401 }) };

  /*
   * Sem tenantId no pedido, vale a loja que o painel está mostrando. Com
   * tenantId, ele ainda passa por `acessoALoja` — o corpo do pedido é palpite
   * do navegador, nunca prova de acesso.
   */
  const loja = tenantIdPedido
    ? await acessoALoja(ctx.usuario.userId, tenantIdPedido)
    : await lojaAtual(ctx);

  if (!loja) return { erro: Response.json({ erro: "não encontrado" }, { status: 404 }) };

  const perfil = await perfilDaLoja(loja.id);
  if (!perfil) {
    return {
      erro: Response.json(
        { erro: "nenhum perfil do Facebook conectado a esta loja" },
        { status: 409 },
      ),
    };
  }

  const app = appDaMeta();
  if (!app) {
    return { erro: Response.json({ erro: "app da Meta não configurado" }, { status: 503 }) };
  }

  return { loja, perfil, app };
}

export async function GET(): Promise<Response> {
  const ctx = await contextoDaLoja();
  if (ctx.erro) return ctx.erro;

  try {
    const { contas, pixels } = await contasEPixels(ctx.app, ctx.perfil.token);

    /* O que já está ligado vem marcado, para a tela mostrar o estado atual. */
    const [jaContas, jaPixels] = await Promise.all([
      db.select({ externalId: adAccounts.externalId })
        .from(adAccounts)
        .where(and(
          eq(adAccounts.tenantId, ctx.loja.id),
          eq(adAccounts.platform, "meta"),
          eq(adAccounts.active, true),
        )),
      db.select({ externalId: destinations.externalId })
        .from(destinations)
        .where(and(
          eq(destinations.tenantId, ctx.loja.id),
          eq(destinations.platform, "meta"),
          eq(destinations.active, true),
        )),
    ]);

    return Response.json({
      loja: { id: ctx.loja.id, nome: ctx.loja.nome },
      perfil: { nome: ctx.perfil.nome },
      expiraEm: ctx.perfil.expiraEm ? ctx.perfil.expiraEm.toISOString() : null,
      contas,
      pixels,
      vinculados: {
        contas: jaContas.map((c) => c.externalId),
        pixels: jaPixels.map((p) => p.externalId),
      },
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

  const ctx = await contextoDaLoja(
    typeof corpo.tenantId === "string" ? corpo.tenantId : undefined,
  );
  if (ctx.erro) return ctx.erro;

  const contas = escolhas(corpo.contas);
  const pixels = escolhas(corpo.pixels);

  const tenantId = ctx.loja.id;
  const cifrado = { accessToken: await encryptValue(ctx.perfil.token) };
  const vence = ctx.perfil.expiraEm;

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

  /*
   * Desmarcar tem de desligar, senão a tela mente: a pessoa tira o visto,
   * salva, e a conta continua sincronizando.
   *
   * Desativa, não apaga. O histórico de gasto e de disparos aponta para estas
   * linhas, e apagá-las levaria o histórico junto.
   */
  const desligados = { contas: 0, pixels: 0 };

  const contasAtuais = await db.select({ id: adAccounts.id, externalId: adAccounts.externalId })
    .from(adAccounts)
    .where(and(
      eq(adAccounts.tenantId, tenantId),
      eq(adAccounts.platform, "meta"),
      eq(adAccounts.active, true),
    ));

  for (const atual of contasAtuais) {
    if (!contas.some((c) => c.id === atual.externalId)) {
      await db.update(adAccounts).set({ active: false }).where(eq(adAccounts.id, atual.id));
      desligados.contas++;
    }
  }

  const pixelsAtuais = await db.select({ id: destinations.id, externalId: destinations.externalId })
    .from(destinations)
    .where(and(
      eq(destinations.tenantId, tenantId),
      eq(destinations.platform, "meta"),
      eq(destinations.active, true),
    ));

  for (const atual of pixelsAtuais) {
    if (!pixels.some((p) => p.id === atual.externalId)) {
      await db.update(destinations).set({ active: false }).where(eq(destinations.id, atual.id));
      desligados.pixels++;
    }
  }

  return Response.json({
    ok: true,
    contas: contas.length,
    pixels: pixels.length,
    desligados,
  });
}
