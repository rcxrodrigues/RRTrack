import { exigirSessao } from "@/core/sessao";
import { acessoALoja } from "@/core/auth";
import { sincronizarGasto } from "@/core/sincronizar-gasto";

export const runtime = "nodejs";
/* A Meta demora. Sem isto a função é cortada no meio da paginação. */
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  const sessao = await exigirSessao();
  if (!sessao.ok) return sessao.resposta;

  const { tenantId, dias, plataforma } = (await req.json().catch(() => ({}))) as {
    tenantId?: string; dias?: number; plataforma?: string;
  };

  if (!tenantId) return Response.json({ erro: "loja não informada" }, { status: 400 });

  const loja = await acessoALoja(sessao.ctx.usuario.userId, tenantId);
  if (!loja) return Response.json({ erro: "não encontrado" }, { status: 404 });

  const resumos = await sincronizarGasto(tenantId, { dias, plataforma });
  return Response.json({ ok: true, resumos });
}
