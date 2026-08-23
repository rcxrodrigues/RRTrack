/*
 * Leitura da sessão do lado do servidor.
 *
 * Fica separado de core/auth.ts porque este arquivo depende do `next/headers`
 * e só roda em requisição. O auth.ts continua puro e testável sem servidor.
 */

import { cookies } from "next/headers";
import { COOKIE, lerSessao, lojasDoUsuario, type LojaDoUsuario, type Sessao } from "./auth";

export interface Contexto {
  usuario: Sessao;
  lojas: LojaDoUsuario[];
}

/** Devolve o usuário e as lojas dele, ou `null` quando não há sessão válida. */
export async function contexto(): Promise<Contexto | null> {
  const jar = await cookies();
  const usuario = await lerSessao(jar.get(COOKIE)?.value);
  if (!usuario) return null;
  return { usuario, lojas: await lojasDoUsuario(usuario.userId) };
}

/**
 * Mesma coisa, mas para rotas de API: em vez de devolver `null`, devolve a
 * resposta 401 pronta. Assim o chamador não esquece de tratar o caso.
 */
export async function exigirSessao(): Promise<
  { ok: true; ctx: Contexto } | { ok: false; resposta: Response }
> {
  const ctx = await contexto();
  if (!ctx) {
    return { ok: false, resposta: Response.json({ erro: "não autenticado" }, { status: 401 }) };
  }
  return { ok: true, ctx };
}
