/*
 * As peças que as três rotas do login com o Facebook compartilham.
 *
 * Fica separado das rotas porque as três precisam concordar sobre duas coisas
 * — qual é a URL de retorno e como o token viaja entre um passo e outro — e
 * duas cópias divergentes disso quebram de um jeito silencioso: o vínculo
 * simplesmente não completa, sem erro em lugar nenhum.
 */

import { cookies } from "next/headers";
import { decryptValue, encryptValue } from "@/core/crypto";
import type { AppMeta } from "./meta-oauth";

/*
 * A URL de retorno tem de ser IDÊNTICA em dois lugares: aqui e na lista de
 * "URIs de redirecionamento válidos" do app na Meta. Um barra a mais no fim já
 * é motivo de recusa, e a mensagem que a Meta devolve não diz qual das duas
 * está diferente.
 */
export function urlDeRetorno(): string {
  const base = process.env.RR_BASE ?? "https://rr-track.vercel.app";
  return `${base.replace(/\/$/, "")}/api/meta/retorno`;
}

export function appDaMeta(): AppMeta | null {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}

/* ------------------------------------------------------------- estado -- */

const COOKIE_ESTADO = "rr_meta_estado";

/*
 * O `state` existe para provar que quem voltou do Facebook é quem saiu daqui.
 * Sem ele, qualquer site consegue mandar a pessoa logada para o nosso retorno
 * com um `code` de outra conta e vincular um perfil que ela não escolheu.
 *
 * O nonce fica num cookie e o par vem de volta na URL; se não baterem, o
 * retorno é descartado.
 */
export async function abrirEstado(tenantId: string): Promise<string> {
  const nonce = crypto.randomUUID();
  const jar = await cookies();

  jar.set(COOKIE_ESTADO, `${nonce}.${tenantId}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  return `${nonce}.${tenantId}`;
}

export async function conferirEstado(state: string | null): Promise<string | null> {
  const jar = await cookies();
  const guardado = jar.get(COOKIE_ESTADO)?.value;
  jar.delete(COOKIE_ESTADO);

  if (!state || !guardado || state !== guardado) return null;
  return state.slice(state.indexOf(".") + 1) || null;
}

/* -------------------------------------------------------------- token -- */

const COOKIE_TOKEN = "rr_meta_token";

/*
 * O token fica num cookie entre o retorno do Facebook e a tela de escolha.
 *
 * É um segredo, então vai cifrado com a mesma chave das credenciais e some em
 * quinze minutos. Guardá-lo no banco antes de a pessoa escolher as contas
 * criaria uma linha órfã toda vez que alguém desistisse no meio.
 */
export async function guardarToken(dados: {
  token: string;
  expiraEm: string | null;
  tenantId: string;
}): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE_TOKEN, await encryptValue(JSON.stringify(dados)), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 900,
  });
}

export async function lerToken(): Promise<
  { token: string; expiraEm: string | null; tenantId: string } | null
> {
  const jar = await cookies();
  const bruto = jar.get(COOKIE_TOKEN)?.value;
  if (!bruto) return null;

  try {
    return JSON.parse(await decryptValue(bruto));
  } catch {
    return null;
  }
}

export async function esquecerToken(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE_TOKEN);
}
