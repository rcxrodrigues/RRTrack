/*
 * Login com o Facebook, para a loja vincular o próprio perfil.
 *
 * O que isto substitui: hoje a pessoa abre o Gerenciador de Negócios, cria um
 * usuário de sistema, gera um token, copia e cola no painel — e erra em algum
 * passo, porque são seis telas e nenhuma delas explica qual permissão o token
 * precisa ter. O sintoma do erro é sempre o mesmo: um HTTP 401 que só aparece
 * quando a primeira venda tenta sair.
 *
 * Aqui a pessoa clica em um botão, escolhe as contas, e o token chega pronto.
 *
 * DUAS ARMADILHAS que valem o comentário:
 *
 * 1. O token que sai do OAuth é de USUÁRIO e vence em 60 dias, mesmo depois de
 *    alongado. Não existe token de usuário eterno. Quem quiser algo que nunca
 *    vence precisa de um usuário de sistema do Business Manager — e aí é o
 *    fluxo manual de novo. Por isso gravamos `credentialsExpireAt`: o painel
 *    avisa antes, em vez de a sincronização parar calada.
 *
 * 2. O token morre junto com o acesso de quem autorizou. Se aquele perfil sair
 *    da empresa, perder o cargo na conta de anúncio ou trocar a senha, o token
 *    para de valer. Vincular pelo perfil do dono é mais seguro que pelo de um
 *    funcionário — e é o tipo de coisa que ninguém pensa na hora de clicar.
 */

import { createHmac } from "node:crypto";

const VERSAO = process.env.META_GRAPH_VERSION ?? "v23.0";
const GRAPH = `https://graph.facebook.com/${VERSAO}`;

/*
 * `ads_read` traz o gasto; `ads_management` é o que permite ENVIAR evento para
 * o pixel pela Conversions API — sem ele o vínculo parece ter dado certo e
 * todo disparo volta 401. `business_management` é o que deixa listar os
 * pixels que pertencem à empresa, não só os da conta de anúncio.
 */
export const ESCOPOS = ["ads_read", "ads_management", "business_management"];

export interface AppMeta {
  appId: string;
  appSecret: string;
}

export interface ContaDeAnuncio {
  id: string;
  nome: string;
  moeda: string;
  /* 1 = ativa. Qualquer outro valor é conta desabilitada, fechada ou em revisão. */
  ativa: boolean;
  empresa?: string;
}

export interface PixelMeta {
  id: string;
  nome: string;
  /* De qual conta de anúncio ele veio — ajuda a pessoa a reconhecer qual é qual. */
  origem?: string;
}

export interface TokenVinculado {
  token: string;
  /** Quando vence, ou `null` quando a Meta diz que não vence (usuário de sistema). */
  expiraEm: Date | null;
  escopos: string[];
  usuarioId: string;
}

/*
 * A Meta aceita chamada só com o token, mas se a opção "exigir segredo do app"
 * estiver ligada no painel dela — e ela vem ligada em app novo — toda chamada
 * sem esta prova volta 400. Mandar sempre custa um hash e evita um erro que se
 * manifesta como "o app funciona no meu computador e não no servidor".
 */
function provaDoApp(token: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(token).digest("hex");
}

async function pedir<T>(
  caminho: string,
  params: Record<string, string>,
  app?: AppMeta,
  token?: string,
): Promise<T> {
  const url = new URL(GRAPH + caminho);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (token) {
    url.searchParams.set("access_token", token);
    if (app) url.searchParams.set("appsecret_proof", provaDoApp(token, app.appSecret));
  }

  const r = await fetch(url, { headers: { accept: "application/json" } });
  const corpo = await r.json().catch(() => null);

  if (!r.ok || corpo?.error) {
    /*
     * A mensagem da Meta é a única pista útil aqui, e ela é específica: diz se
     * faltou permissão, se o token venceu ou se o app não tem acesso àquela
     * conta. Engolir isso num "falha ao conectar" genérico transforma um
     * problema de dez segundos numa tarde de tentativa e erro.
     */
    const e = corpo?.error;
    throw new Error(e?.message ?? `Meta respondeu HTTP ${r.status}`);
  }

  return corpo as T;
}

/** Para onde mandar a pessoa clicar. O `state` volta intacto no retorno. */
export function urlAutorizacao(
  app: AppMeta,
  redirectUri: string,
  state: string,
): string {
  const u = new URL(`https://www.facebook.com/${VERSAO}/dialog/oauth`);
  u.searchParams.set("client_id", app.appId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("scope", ESCOPOS.join(","));
  u.searchParams.set("response_type", "code");
  return u.toString();
}

/*
 * O código do retorno vale uma vez só e por poucos minutos. Ele vira um token
 * curto (1-2 h), que precisa ser trocado por um longo NA MESMA hora — o curto
 * não sobrevive a um deploy.
 */
export async function trocarCodigo(
  app: AppMeta,
  redirectUri: string,
  code: string,
): Promise<string> {
  const r = await pedir<{ access_token: string }>("/oauth/access_token", {
    client_id: app.appId,
    client_secret: app.appSecret,
    redirect_uri: redirectUri,
    code,
  });
  return r.access_token;
}

export async function alongarToken(app: AppMeta, tokenCurto: string): Promise<string> {
  const r = await pedir<{ access_token: string }>("/oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: app.appId,
    client_secret: app.appSecret,
    fb_exchange_token: tokenCurto,
  });
  return r.access_token;
}

/*
 * Confere o que o token realmente carrega, em vez de assumir.
 *
 * Vale a chamada porque a pessoa pode desmarcar permissões na tela de
 * consentimento sem perceber que desmarcou. O vínculo dá certo, e só semanas
 * depois alguém descobre que o gasto nunca sincronizou.
 */
export async function inspecionar(app: AppMeta, token: string): Promise<TokenVinculado> {
  const r = await pedir<{
    data: {
      scopes?: string[];
      expires_at?: number;
      user_id?: string;
      is_valid?: boolean;
    };
  }>("/debug_token", {
    input_token: token,
    access_token: `${app.appId}|${app.appSecret}`,
  });

  const d = r.data ?? {};
  if (!d.is_valid) throw new Error("a Meta devolveu um token que já não vale");

  return {
    token,
    /* `expires_at` 0 significa que não vence — é o caso do usuário de sistema. */
    expiraEm: d.expires_at ? new Date(d.expires_at * 1000) : null,
    escopos: d.scopes ?? [],
    usuarioId: d.user_id ?? "",
  };
}

/** O que falta para este token servir. Vazio quer dizer que está completo. */
export function escoposFaltando(escopos: string[]): string[] {
  return ESCOPOS.filter((e) => !escopos.includes(e));
}

interface ContaBruta {
  account_id?: string;
  id?: string;
  name?: string;
  currency?: string;
  account_status?: number;
  business?: { name?: string };
  adspixels?: { data?: Array<{ id: string; name?: string }> };
}

/*
 * Contas e pixels numa chamada só.
 *
 * Os pixels vêm aninhados na conta de propósito: o mesmo pixel costuma
 * aparecer em mais de uma conta, e saber de onde veio é o que permite à pessoa
 * distinguir dois pixels de nome parecido. A deduplicação é por id.
 */
export async function contasEPixels(
  app: AppMeta,
  token: string,
): Promise<{ contas: ContaDeAnuncio[]; pixels: PixelMeta[] }> {
  const r = await pedir<{ data?: ContaBruta[] }>("/me/adaccounts", {
    fields: "account_id,name,currency,account_status,business{name},adspixels{id,name}",
    limit: "100",
  }, app, token);

  const contas: ContaDeAnuncio[] = [];
  const pixels = new Map<string, PixelMeta>();

  for (const c of r.data ?? []) {
    const id = c.account_id ?? c.id?.replace(/^act_/, "");
    if (!id) continue;

    const nome = c.name ?? `Conta ${id}`;
    contas.push({
      id,
      nome,
      moeda: c.currency ?? "BRL",
      ativa: c.account_status === 1,
      empresa: c.business?.name,
    });

    for (const p of c.adspixels?.data ?? []) {
      if (!pixels.has(p.id)) {
        pixels.set(p.id, { id: p.id, nome: p.name ?? `Pixel ${p.id}`, origem: nome });
      }
    }
  }

  return { contas, pixels: [...pixels.values()] };
}

/** Quem é o dono deste token. O nome é só para a pessoa se reconhecer na tela. */
export async function perfil(
  app: AppMeta,
  token: string,
): Promise<{ id: string; nome: string }> {
  const r = await pedir<{ id?: string; name?: string }>(
    "/me", { fields: "id,name" }, app, token,
  );
  return { id: r.id ?? "", nome: r.name ?? "Perfil do Facebook" };
}
