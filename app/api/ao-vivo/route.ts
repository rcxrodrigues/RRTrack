/*
 * Quem está no site agora, para a seção que se atualiza sozinha.
 *
 * Existe separado do Resumo porque as duas coisas têm ritmos diferentes. O
 * resto da tela — faturamento, funil, mapa de horário — são agregações pesadas
 * que não mudam em dez segundos, e recalculá-las nesse ritmo seria gastar
 * consulta à toa. "Agora" muda o tempo todo, e é o único número em que meio
 * minuto de atraso se nota.
 */

import { aoVivo } from "@/core/aovivo";
import { contexto } from "@/core/sessao";
import { lojaAtual } from "@/core/loja-atual";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const ctx = await contexto();
  if (!ctx) return Response.json({ erro: "não autenticado" }, { status: 401 });

  const loja = await lojaAtual(ctx);
  if (!loja) return Response.json({ erro: "nenhuma loja" }, { status: 404 });

  /*
   * A loja vem do cookie e é confirmada contra os vínculos do usuário dentro
   * de `lojaAtual` — quem editar o cookie para o apelido de outra conta não
   * chega aqui com o tenant dela.
   */
  return Response.json(await aoVivo(loja.id), {
    headers: { "cache-control": "no-store" },
  });
}
