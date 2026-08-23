/*
 * Qual loja o painel está mostrando.
 *
 * A escolha vive num cookie e não na URL. Assim ela sobrevive à navegação
 * entre telas, e ninguém abre um link colado sem parâmetro e vê a loja errada
 * sem perceber.
 *
 * A regra que não se quebra: o cookie é PALPITE do navegador, nunca prova. A
 * loja só é aceita depois de confirmada contra os vínculos do usuário — quem
 * editar o cookie à mão para o slug de outra conta não vê nada.
 */

import { cookies } from "next/headers";
import type { Contexto } from "./sessao";
import type { LojaDoUsuario } from "./auth";

export const COOKIE_LOJA = "rr_loja";

export async function lojaAtual(ctx: Contexto): Promise<LojaDoUsuario | null> {
  const jar = await cookies();
  const slug = jar.get(COOKIE_LOJA)?.value;

  const escolhida = slug ? ctx.lojas.find((l) => l.slug === slug) : undefined;
  /* Sem cookie válido, cai na primeira loja — e não em "nenhuma", que deixaria
     o painel vazio sem explicar o motivo a quem só tem uma loja. */
  return escolhida ?? ctx.lojas[0] ?? null;
}
