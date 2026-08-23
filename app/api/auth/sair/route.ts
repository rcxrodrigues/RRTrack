import { cookies } from "next/headers";
import { COOKIE, encerrarSessao } from "@/core/auth";

export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  const jar = await cookies();
  /* Apaga a linha no banco, não só o cookie: sessão que só some do navegador
     continuaria valendo para quem tivesse copiado o token. */
  await encerrarSessao(jar.get(COOKIE)?.value);
  jar.delete(COOKIE);
  return Response.json({ ok: true });
}
