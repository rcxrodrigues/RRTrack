/*
 * Criar um dashboard novo, e trocar de dashboard.
 *
 * "Dashboard" aqui é o que o modelo de dados chama de loja: a unidade que
 * isola gateways, pixels, contas de anúncio e chave de site. Rodar duas
 * ofertas com pixels diferentes na mesma loja mandaria toda venda para os
 * dois pixels — cada algoritmo otimizaria com dado da outra oferta. Loja
 * separada é o que impede isso, e é por isso que criar uma é operação de
 * primeira classe e não configuração escondida.
 */

import { and, eq, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { db } from "@/db/index";
import { memberships, sites, tenants } from "@/db/schema";
import { contexto } from "@/core/sessao";
import { COOKIE_LOJA } from "@/core/loja-atual";

export const runtime = "nodejs";

/** "Oferta Carimbo 2" -> "oferta-carimbo-2" */
function apelido(nome: string): string {
  return nome.normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function chaveDeSite(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return "pk_" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/* --------------------------------------------------------------- criar -- */

export async function POST(req: Request): Promise<Response> {
  const ctx = await contexto();
  if (!ctx) return Response.json({ erro: "não autenticado" }, { status: 401 });

  const corpo = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const nome = typeof corpo.nome === "string" ? corpo.nome.trim() : "";
  const dominio = typeof corpo.dominio === "string" ? corpo.dominio.trim().toLowerCase() : "";
  const descricao = typeof corpo.descricao === "string" && corpo.descricao.trim()
    ? corpo.descricao.trim() : null;
  const timezone = typeof corpo.timezone === "string" && corpo.timezone
    ? corpo.timezone : "America/Sao_Paulo";
  const currency = typeof corpo.moeda === "string" && corpo.moeda ? corpo.moeda : "BRL";

  /*
   * O padrão conta os dois, que é o que o gateway informa. Só desliga quem
   * disser explicitamente `false` — `undefined` de um cliente antigo não pode
   * virar "não contar" e mudar o faturamento de quem nunca escolheu.
   */
  const countShipping = corpo.contarFrete !== false;
  const countInterest = corpo.contarJuros !== false;

  if (nome.length < 2) {
    return Response.json({ erro: "dê um nome ao dashboard" }, { status: 400 });
  }

  const base = apelido(nome);
  if (!base) return Response.json({ erro: "nome sem letras aproveitáveis" }, { status: 400 });

  /*
   * O apelido é único no sistema inteiro, e duas pessoas podem escolher o
   * mesmo nome. Em vez de recusar, acrescentamos sufixo — recusar obrigaria a
   * pessoa a inventar nome por causa de uma colisão que não é problema dela.
   */
  let slug = base;
  for (let i = 2; i < 50; i++) {
    const [existe] = await db.select({ id: tenants.id }).from(tenants)
      .where(eq(tenants.slug, slug)).limit(1);
    if (!existe) break;
    slug = `${base}-${i}`;
  }

  const [loja] = await db.insert(tenants)
    .values({ name: nome, slug, timezone, currency, description: descricao, countShipping, countInterest })
    .returning({ id: tenants.id, slug: tenants.slug, name: tenants.name });

  if (!loja) return Response.json({ erro: "falha ao criar" }, { status: 500 });

  /* Quem cria é dono. Sem isto a loja nasceria invisível para o próprio autor. */
  await db.insert(memberships)
    .values({ tenantId: loja.id, userId: ctx.usuario.userId, role: "owner" })
    .onConflictDoNothing();

  /*
   * O domínio é opcional na criação: dá para montar o dashboard e conectar o
   * site depois. Mas sem site não há coleta, então quando vem, já nasce com a
   * chave pública pronta para o snippet.
   */
  let siteKey: string | null = null;
  if (dominio) {
    const [jaExiste] = await db.select({ id: sites.id }).from(sites)
      .where(eq(sites.domain, dominio)).limit(1);

    if (jaExiste) {
      return Response.json({
        erro: `o domínio ${dominio} já está em outro dashboard`,
        criado: loja.slug,
      }, { status: 409 });
    }

    siteKey = chaveDeSite();
    await db.insert(sites).values({
      tenantId: loja.id,
      domain: dominio,
      collectorHost: `t.${dominio.replace(/^www\./, "")}`,
      publicKey: siteKey,
      active: true,
    });
  }

  /* Já entra no dashboard novo — foi para isso que ele o criou. */
  const jar = await cookies();
  jar.set(COOKIE_LOJA, loja.slug, {
    httpOnly: true, sameSite: "lax", path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });

  return Response.json({ ok: true, slug: loja.slug, nome: loja.name, siteKey });
}

/* --------------------------------------------------------------- trocar -- */

export async function PUT(req: Request): Promise<Response> {
  const ctx = await contexto();
  if (!ctx) return Response.json({ erro: "não autenticado" }, { status: 401 });

  const { slug } = (await req.json().catch(() => ({}))) as { slug?: string };

  /*
   * O cookie é palpite do navegador, nunca prova — a mesma regra do
   * loja-atual.ts. Só grava depois de confirmar que a pessoa tem vínculo com
   * a loja; quem editar o cookie à mão para o apelido de outra conta não vê
   * nada de qualquer forma, mas recusar aqui evita o cookie sujo.
   */
  const permitida = ctx.lojas.find((l) => l.slug === slug);
  if (!permitida) return Response.json({ erro: "sem acesso a esse dashboard" }, { status: 403 });

  const jar = await cookies();
  jar.set(COOKIE_LOJA, permitida.slug, {
    httpOnly: true, sameSite: "lax", path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });

  return Response.json({ ok: true, slug: permitida.slug });
}

/* -------------------------------------------------------------- listar -- */

export async function GET(): Promise<Response> {
  const ctx = await contexto();
  if (!ctx) return Response.json({ erro: "não autenticado" }, { status: 401 });

  const comSite = await db
    .select({ tenantId: sites.tenantId, domain: sites.domain })
    .from(sites)
    .where(and(eq(sites.active, true)));

  const dominios = new Map(comSite.map((s) => [s.tenantId, s.domain]));

  return Response.json({
    lojas: ctx.lojas.map((l) => ({
      slug: l.slug, nome: l.nome, dominio: dominios.get(l.id) ?? null,
    })),
  });
}

/* ------------------------------------------------------------- editar -- */

export async function PATCH(req: Request): Promise<Response> {
  const ctx = await contexto();
  if (!ctx) return Response.json({ erro: "não autenticado" }, { status: 401 });

  const corpo = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const alvo = ctx.lojas.find((l) => l.slug === corpo.slug);
  if (!alvo) return Response.json({ erro: "sem acesso a esse dashboard" }, { status: 403 });

  const mudancas: Record<string, unknown> = {};

  if (typeof corpo.nome === "string") {
    const nome = corpo.nome.trim();
    if (nome.length < 2) return Response.json({ erro: "o nome precisa de 2 letras" }, { status: 400 });
    mudancas.name = nome;
  }

  if ("descricao" in corpo) {
    const d = typeof corpo.descricao === "string" ? corpo.descricao.trim() : "";
    mudancas.description = d || null;
  }

  if (typeof corpo.timezone === "string" && corpo.timezone) mudancas.timezone = corpo.timezone;
  if (typeof corpo.moeda === "string" && corpo.moeda) mudancas.currency = corpo.moeda;
  if (typeof corpo.contarFrete === "boolean") mudancas.countShipping = corpo.contarFrete;
  if (typeof corpo.contarJuros === "boolean") mudancas.countInterest = corpo.contarJuros;

  if (Object.keys(mudancas).length === 0) {
    return Response.json({ erro: "nada para mudar" }, { status: 400 });
  }

  /*
   * O apelido NÃO muda junto com o nome, de propósito. Ele é o que o cookie
   * guarda e o que aparece na URL; trocá-lo derrubaria a sessão de quem
   * estivesse com o dashboard aberto noutra aba, e por um motivo cosmético.
   */
  await db.update(tenants).set(mudancas).where(eq(tenants.id, alvo.id));

  return Response.json({ ok: true, slug: alvo.slug });
}

/* ------------------------------------------------------------ excluir -- */

export async function DELETE(req: Request): Promise<Response> {
  const ctx = await contexto();
  if (!ctx) return Response.json({ erro: "não autenticado" }, { status: 401 });

  const { slug, confirmacao } = (await req.json().catch(() => ({}))) as {
    slug?: string; confirmacao?: string;
  };

  const alvo = ctx.lojas.find((l) => l.slug === slug);
  if (!alvo) return Response.json({ erro: "sem acesso a esse dashboard" }, { status: 403 });

  /* Só dono apaga. Quem foi convidado para ver não leva a loja junto. */
  if (alvo.papel !== "owner") {
    return Response.json({ erro: "só o dono pode excluir" }, { status: 403 });
  }

  /*
   * Não dá para ficar sem nenhum. Sem esta trava, apagar o último deixaria o
   * painel numa tela de "nenhuma loja cadastrada" sem caminho de volta pela
   * interface — só por script.
   */
  if (ctx.lojas.length <= 1) {
    return Response.json({
      erro: "este é o único dashboard; crie outro antes de excluir",
    }, { status: 409 });
  }

  /*
   * Exigir o nome digitado não é burocracia: a exclusão leva junto, em
   * cascata, todas as vendas, sessões de clique, eventos, disparos e
   * conexões de gateway. Não há desfazer, e a lixeira não existe.
   */
  if ((confirmacao ?? "").trim() !== alvo.nome) {
    return Response.json({
      erro: "digite o nome exato do dashboard para confirmar",
    }, { status: 400 });
  }

  const [contagem] = await db
    .select({
      pedidos: sql<number>`(SELECT count(*)::int FROM orders WHERE tenant_id = ${alvo.id})`,
      sessoes: sql<number>`(SELECT count(*)::int FROM click_sessions WHERE tenant_id = ${alvo.id})`,
    })
    .from(tenants)
    .where(eq(tenants.id, alvo.id));

  await db.delete(tenants).where(eq(tenants.id, alvo.id));

  /* Cai no primeiro que sobrou, para o painel não abrir órfão. */
  const proxima = ctx.lojas.find((l) => l.slug !== alvo.slug);
  const jar = await cookies();
  if (proxima) {
    jar.set(COOKIE_LOJA, proxima.slug, {
      httpOnly: true, sameSite: "lax", path: "/",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  return Response.json({
    ok: true,
    removidos: { pedidos: contagem?.pedidos ?? 0, sessoes: contagem?.sessoes ?? 0 },
    agora: proxima?.slug ?? null,
  });
}
