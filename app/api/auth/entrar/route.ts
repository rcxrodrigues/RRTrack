import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { db } from "@/db/index";
import { users } from "@/db/schema";
import { COOKIE, conferirSenha, criarSessao } from "@/core/auth";
import { ipDoCliente } from "@/core/ip";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const { email, senha } = (await req.json().catch(() => ({}))) as {
    email?: string; senha?: string;
  };

  if (!email || !senha) {
    return Response.json({ erro: "informe e-mail e senha" }, { status: 400 });
  }

  const [u] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);

  /*
   * Mesma mensagem para e-mail inexistente e senha errada, de propósito:
   * mensagens diferentes contam a quem tenta se aquele e-mail tem conta aqui.
   */
  const generico = Response.json({ erro: "e-mail ou senha incorretos" }, { status: 401 });

  if (!u?.passwordHash) return generico;
  if (!(await conferirSenha(senha, u.passwordHash))) return generico;

  /* Aqui o IP serve para reconhecer sessão suspeita, e o da borda do proxy não
     reconhece nada — a ordem dos cabeçalhos está em core/ip.ts, num lugar só. */
  const { token, expiraEm } = await criarSessao(u.id, {
    userAgent: req.headers.get("user-agent") ?? undefined,
    ip: ipDoCliente(req),
  });

  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,          /* fora do alcance de qualquer script na página */
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",         /* sobrevive à volta de um provedor externo */
    path: "/",
    expires: expiraEm,
  });

  await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, u.id));

  return Response.json({ ok: true, nome: u.name, email: u.email });
}
