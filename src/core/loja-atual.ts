/*
 * Qual loja o painel está mostrando.
 *
 * QUEM DECIDE É O ENDEREÇO, quando o endereço sabe responder.
 *
 * Cada oferta tem o painel dela num subdomínio próprio (`track.transforlar.com`),
 * e todos apontam para o MESMO app e o MESMO banco — a Vercel serve o projeto
 * inteiro em qualquer domínio ligado a ele. Isso quer dizer que o subdomínio,
 * sozinho, não isola nada: abrir `track.transforlar.com` mostrava a loja que o
 * cookie dissesse, ou, sem cookie, a PRIMEIRA da lista.
 *
 * E a lista é `ORDER BY tenants.name`. Numa conta com uma loja chamada "QA
 * Interface Renomeada", abrir o painel da Transforlar num navegador sem cookie
 * mostrava a loja de QA — nome certo no endereço, dado errado na tela, e nada
 * indicando a troca. Foi o que aconteceu de verdade.
 *
 * Agora o host manda: `track.transforlar.com` é a loja dona do site
 * `transforlar.com`, e acabou. O cookie só vale onde o endereço NÃO representa
 * loja nenhuma — que é o domínio do próprio RRTrack, onde o painel é console e
 * o seletor faz sentido.
 *
 * A regra antiga continua de pé: o cookie é PALPITE do navegador, nunca prova.
 * A loja só é aceita depois de confirmada contra os vínculos do usuário.
 */

import { cookies, headers } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { sites } from "../db/schema";
import { mesmoSite } from "./dominio";
import type { Contexto } from "./sessao";
import type { LojaDoUsuario } from "./auth";

export const COOKIE_LOJA = "rr_loja";

export interface LojaDoEndereco {
  /** O endereço representa alguma loja cadastrada? */
  prende: boolean;
  /** A loja, quando o usuário tem acesso a ela. */
  loja: LojaDoUsuario | null;
  /** O domínio que o endereço representa — para a tela poder DIZER qual é. */
  dominio?: string;
}

/**
 * A loja que este endereço representa.
 *
 * `mesmoSite` já sabe que `track.transforlar.com` e `transforlar.com` são o
 * mesmo domínio registrável — é a mesma função que decide se o cookie de
 * primeira parte cola, então as duas coisas não podem divergir.
 */
export async function lojaDoEndereco(ctx: Contexto): Promise<LojaDoEndereco> {
  const cabecalhos = await headers();
  const host = cabecalhos.get("host");
  if (!host) return { prende: false, loja: null };

  /*
   * TODOS os sites ativos, não só os do usuário.
   *
   * Filtrar pelos dele faria "endereço de loja que não é sua" parecer
   * "endereço que não representa loja nenhuma" — e aí cairia no cookie e
   * mostraria OUTRA loja, que é exatamente o comportamento que isto remove.
   * A tela precisa poder dizer "essa loja não é sua" em vez de trocar calada.
   */
  const ativos = await db.select({ tenantId: sites.tenantId, domain: sites.domain })
    .from(sites).where(eq(sites.active, true));

  const casado = ativos.find((s) => mesmoSite(host, s.domain));
  if (!casado) return { prende: false, loja: null };

  const minha = ctx.lojas.find((l) => l.id === casado.tenantId) ?? null;
  return { prende: true, loja: minha, dominio: casado.domain };
}

export async function lojaAtual(ctx: Contexto): Promise<LojaDoUsuario | null> {
  const doEndereco = await lojaDoEndereco(ctx);
  /*
   * Preso é preso: se o endereço representa uma loja, é ela ou nenhuma. Cair
   * no cookie aqui traria de volta o defeito inteiro — o endereço diria uma
   * coisa e a tela mostraria outra.
   */
  if (doEndereco.prende) return doEndereco.loja;

  const jar = await cookies();
  const slug = jar.get(COOKIE_LOJA)?.value;

  const escolhida = slug ? ctx.lojas.find((l) => l.slug === slug) : undefined;
  /* Sem cookie válido, cai na primeira loja — e não em "nenhuma", que deixaria
     o painel vazio sem explicar o motivo a quem só tem uma loja. */
  return escolhida ?? ctx.lojas[0] ?? null;
}
