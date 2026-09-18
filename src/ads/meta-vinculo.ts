/*
 * O estado de um login com o Facebook em andamento.
 *
 * Mora no banco, não em cookie. A razão está no comentário da tabela
 * `meta_links`: quem gerencia vários perfis autoriza dentro de um navegador
 * antidetect, e o painel está aberto em outro. Cookie não atravessa essa
 * fronteira — o retorno chegaria sem ele e seria descartado como se fosse
 * ataque, sem nada na tela explicando por quê.
 *
 * O `secret` faz o papel que o cookie fazia: prova que o retorno pertence a um
 * pedido que nasceu aqui. A diferença é que ele viaja na URL, então qualquer
 * navegador serve — e é por isso que ele precisa valer pouco tempo e uma vez só.
 */

import { and, desc, eq, gt, isNotNull } from "drizzle-orm";
import { db } from "@/db/index";
import { metaLinks, metaProfiles } from "@/db/schema";
import { decryptValue, encryptValue } from "@/core/crypto";
import type { AppMeta } from "./meta-oauth";

/*
 * Trinta minutos.
 *
 * Eram quinze, e apertava: quem gera o link no painel, copia, abre o
 * navegador antidetect, escolhe o perfil certo e cola, gasta boa parte disso
 * antes de clicar. A Utmify usa trinta, e é a folga certa — dá tempo de
 * atravessar a troca de navegador sem dar tempo de esquecer que gerou.
 */
export const VALIDADE_MINUTOS = 30;

/*
 * A URL de retorno tem de ser IDÊNTICA em dois lugares: aqui e na lista de
 * "URIs de redirecionamento do OAuth válidos" do app na Meta. Uma barra a mais
 * no fim já é motivo de recusa, e a mensagem que a Meta devolve não diz qual
 * das duas está diferente.
 */
export function urlDeRetorno(): string {
  return `${base()}/api/meta/retorno`;
}

export function base(): string {
  return (process.env.RR_BASE ?? "https://rr-track.vercel.app").replace(/\/$/, "");
}

export function appDaMeta(): AppMeta | null {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}

export interface Vinculo {
  id: string;
  tenantId: string;
  secret: string;
  token: string | null;
  tokenExpiresAt: Date | null;
}

/* Um pedido novo. O segredo é o que vai na URL, então precisa ser imprevisível. */
export async function abrirVinculo(tenantId: string, userId: string): Promise<Vinculo> {
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");

  const [linha] = await db.insert(metaLinks).values({
    tenantId,
    userId,
    secret,
    expiresAt: new Date(Date.now() + VALIDADE_MINUTOS * 60_000),
  }).returning({ id: metaLinks.id });

  return { id: linha!.id, tenantId, secret, token: null, tokenExpiresAt: null };
}

/** O link que se abre no outro navegador. */
export function urlDoLink(secret: string): string {
  return `${base()}/vincular/meta/${secret}`;
}

/*
 * Busca pelo segredo, já descartando o que venceu.
 *
 * O filtro de validade vive na consulta, não em um `if` depois: assim não
 * existe caminho no código que leia um vínculo vencido por engano.
 */
export async function acharPeloSegredo(secret: string): Promise<Vinculo | null> {
  const [linha] = await db.select().from(metaLinks)
    .where(and(eq(metaLinks.secret, secret), gt(metaLinks.expiresAt, new Date())))
    .limit(1);

  if (!linha) return null;

  return {
    id: linha.id,
    tenantId: linha.tenantId,
    secret: linha.secret,
    token: linha.token ? await decryptValue(linha.token) : null,
    tokenExpiresAt: linha.tokenExpiresAt,
  };
}

/*
 * O vínculo pronto mais recente desta pessoa nesta loja.
 *
 * É como a tela de escolha reencontra o token depois que o consentimento
 * aconteceu em OUTRO navegador: ela não tem o segredo, mas tem a sessão.
 */
export async function vinculoPronto(tenantId: string, userId: string): Promise<Vinculo | null> {
  const [linha] = await db.select().from(metaLinks)
    .where(and(
      eq(metaLinks.tenantId, tenantId),
      eq(metaLinks.userId, userId),
      isNotNull(metaLinks.token),
      gt(metaLinks.expiresAt, new Date()),
    ))
    /*
     * Do mais novo para o mais velho. Sem o `desc`, `orderBy` é ascendente e
     * isto devolvia o vínculo mais ANTIGO — o oposto do que o nome promete.
     * Quem tentasse de novo depois de um consentimento que falhou reencontrava
     * a tentativa velha, e não a que acabou de dar certo.
     */
    .orderBy(desc(metaLinks.createdAt))
    .limit(1);

  if (!linha) return null;

  return {
    id: linha.id,
    tenantId: linha.tenantId,
    secret: linha.secret,
    token: linha.token ? await decryptValue(linha.token) : null,
    tokenExpiresAt: linha.tokenExpiresAt,
  };
}

export async function guardarToken(
  id: string,
  token: string,
  expiraEm: Date | null,
): Promise<void> {
  await db.update(metaLinks)
    .set({ token: await encryptValue(token), tokenExpiresAt: expiraEm })
    .where(eq(metaLinks.id, id));
}

/*
 * Uso único: o vínculo some assim que as escolhas viram linhas de verdade.
 *
 * Deixar a linha viva depois disso manteria um token de 60 dias guardado num
 * lugar que ninguém mais consulta — cópia extra de credencial, sem utilidade.
 */
export async function fecharVinculo(id: string): Promise<void> {
  await db.delete(metaLinks).where(eq(metaLinks.id, id));
}

/* ------------------------------------------------------------- perfil -- */

export interface Perfil {
  id: string;
  fbUserId: string;
  nome: string;
  token: string;
  expiraEm: Date | null;
}

/*
 * Guarda — ou renova — o perfil conectado.
 *
 * Reconectar tem de cair na MESMA linha, e é por isso que a chave é o par
 * (loja, id do Facebook). Se cada login criasse um perfil novo, o painel
 * acumularia entradas idênticas e ninguém saberia qual token está valendo.
 */
export async function salvarPerfil(
  tenantId: string,
  fbUserId: string,
  nome: string,
  token: string,
  expiraEm: Date | null,
): Promise<void> {
  const cifrado = await encryptValue(token);

  await db.insert(metaProfiles)
    .values({ tenantId, fbUserId, name: nome, token: cifrado, tokenExpiresAt: expiraEm })
    .onConflictDoUpdate({
      target: [metaProfiles.tenantId, metaProfiles.fbUserId],
      set: { name: nome, token: cifrado, tokenExpiresAt: expiraEm, connectedAt: new Date() },
    });
}

export async function perfilDaLoja(tenantId: string): Promise<Perfil | null> {
  const [linha] = await db.select().from(metaProfiles)
    .where(eq(metaProfiles.tenantId, tenantId))
    .limit(1);

  if (!linha) return null;

  return {
    id: linha.id,
    fbUserId: linha.fbUserId,
    nome: linha.name,
    token: await decryptValue(linha.token),
    expiraEm: linha.tokenExpiresAt,
  };
}

export async function esquecerPerfil(tenantId: string): Promise<void> {
  await db.delete(metaProfiles).where(eq(metaProfiles.tenantId, tenantId));
}
