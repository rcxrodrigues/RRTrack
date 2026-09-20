/*
 * Autenticação: senha, sessão e o vínculo entre pessoa e loja.
 *
 * Existe porque a tela de Integrações guarda token da Meta e chave de API de
 * gateway. Uma página que edita credencial não pode ficar aberta, e o segredo
 * na URL — que protege o webhook — não serve para painel.
 */

import { and, eq, gt } from "drizzle-orm";
import { db } from "../db/index";
import { memberships, sessions, tenants, users } from "../db/schema";

const enc = new TextEncoder();

/*
 * Custo do PBKDF2.
 *
 * Alto de propósito: o objetivo é que testar senhas seja caro para quem roubar
 * o banco. Fica gravado junto com o hash para poder subir com o tempo sem
 * invalidar quem já tem senha — ao conferir, usamos o número que veio no
 * registro, não este.
 */
const ITERACOES = 210_000;

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const deB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derivar(senha: string, sal: Uint8Array, iteracoes: number): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey("raw", enc.encode(senha), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: sal as BufferSource, iterations: iteracoes, hash: "SHA-256" },
    material,
    256,
  );
  return new Uint8Array(bits);
}

/** Devolve "iteracoes.sal.hash". */
export async function hashSenha(senha: string): Promise<string> {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivar(senha, sal, ITERACOES);
  return `${ITERACOES}.${b64(sal)}.${b64(hash)}`;
}

export async function conferirSenha(senha: string, guardado: string): Promise<boolean> {
  const [it, salB64, hashB64] = guardado.split(".");
  if (!it || !salB64 || !hashB64) return false;

  const iteracoes = parseInt(it, 10);
  if (!Number.isFinite(iteracoes) || iteracoes < 1000) return false;

  const esperado = deB64(hashB64);
  const obtido = await derivar(senha, deB64(salB64), iteracoes);

  return igualEmTempoConstante(obtido, esperado);
}

/**
 * Compara sem entregar o segredo pelo relógio.
 *
 * `a === b` para no primeiro byte diferente, e essa diferença de tempo, medida
 * muitas vezes, revela o valor byte a byte. Vale para hash de senha e para
 * qualquer segredo comparado no servidor — o da rotina de manutenção, por
 * exemplo.
 *
 * O tamanho diferente sai cedo de propósito: ele já é público (vai no corpo da
 * requisição) e esconder isso custaria sem proteger nada.
 */
export function igualEmTempoConstante(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** O mesmo, para texto. */
export function textoIgualEmTempoConstante(a: string, b: string): boolean {
  return igualEmTempoConstante(enc.encode(a), enc.encode(b));
}

/* ------------------------------------------------------------- sessões -- */

export const COOKIE = "rr_sessao";
const DIAS = 30;

async function hashToken(token: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(token));
  return b64(new Uint8Array(d));
}

/**
 * Cria a sessão e devolve o token que vai no cookie.
 *
 * O banco guarda só o hash: quem conseguir ler a tabela não monta um cookie
 * válido a partir dela. É a mesma lógica de senha, aplicada à sessão.
 */
export async function criarSessao(
  userId: string,
  meta: { userAgent?: string; ip?: string } = {},
): Promise<{ token: string; expiraEm: Date }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = b64(bytes).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" }[c] ?? c));
  const expiraEm = new Date(Date.now() + DIAS * 86400_000);

  await db.insert(sessions).values({
    userId,
    tokenHash: await hashToken(token),
    userAgent: meta.userAgent ?? null,
    ip: meta.ip ?? null,
    expiresAt: expiraEm,
  });

  return { token, expiraEm };
}

export interface Sessao {
  userId: string;
  email: string;
  nome: string | null;
}

/** Resolve o cookie para um usuário, ou `null`. */
export async function lerSessao(token: string | undefined): Promise<Sessao | null> {
  if (!token) return null;

  const [linha] = await db
    .select({ userId: users.id, email: users.email, nome: users.name })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(
      eq(sessions.tokenHash, await hashToken(token)),
      /* Sessão vencida é como se não existisse, mesmo antes da limpeza. */
      gt(sessions.expiresAt, new Date()),
    ))
    .limit(1);

  return linha ?? null;
}

export async function encerrarSessao(token: string | undefined): Promise<void> {
  if (!token) return;
  await db.delete(sessions).where(eq(sessions.tokenHash, await hashToken(token)));
}

/* --------------------------------------------------------------- lojas -- */

export interface LojaDoUsuario {
  id: string;
  nome: string;
  slug: string;
  papel: string;
  timezone: string;
  currency: string;
  descricao: string | null;
  /* O que conta como faturamento nesta loja — ver core/faturamento.ts. */
  countShipping: boolean;
  countInterest: boolean;
}

/**
 * As lojas que esta pessoa pode ver.
 *
 * Toda consulta do painel passa por aqui antes de tocar em dado de negócio.
 * É o ponto único onde "quem é você" vira "o que você pode ler" — espalhar
 * essa decisão por várias telas é como um painel multi-loja acaba mostrando
 * a venda de um cliente para outro.
 */
export async function lojasDoUsuario(userId: string): Promise<LojaDoUsuario[]> {
  return db
    .select({
      id: tenants.id,
      nome: tenants.name,
      slug: tenants.slug,
      papel: memberships.role,
      timezone: tenants.timezone,
      currency: tenants.currency,
      descricao: tenants.description,
      countShipping: tenants.countShipping,
      countInterest: tenants.countInterest,
    })
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(eq(memberships.userId, userId))
    .orderBy(tenants.name);
}

/**
 * Confirma que a pessoa tem acesso a uma loja específica.
 * Devolve `null` quando não tem — nunca lança, para que o chamador trate como
 * "não encontrado" e não vaze a existência da loja pela mensagem de erro.
 */
export async function acessoALoja(userId: string, tenantId: string): Promise<LojaDoUsuario | null> {
  const [linha] = await db
    .select({
      id: tenants.id,
      nome: tenants.name,
      slug: tenants.slug,
      papel: memberships.role,
      timezone: tenants.timezone,
      currency: tenants.currency,
      descricao: tenants.description,
      countShipping: tenants.countShipping,
      countInterest: tenants.countInterest,
    })
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)))
    .limit(1);

  return linha ?? null;
}
