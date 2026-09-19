/*
 * Meta Conversions API.
 *
 * Este é o arquivo que decide o Event Match Quality. A regra é simples e vale
 * repetir: o EMQ não sobe porque o evento chegou, sobe porque o evento chegou
 * com muitas chaves de correspondência corretas. Um `purchase` com IP e
 * user-agent apenas empata com nada; o mesmo `purchase` com e-mail, telefone,
 * nome, fbp, fbc e external_id é outra coisa.
 *
 * De onde vem cada chave, sem GTM e sem pixel no navegador:
 *
 *   em, ph, fn, ln   -> webhook do gateway (é o único lugar onde existem)
 *   fbp, fbc         -> nosso snippet, salvos na sessão de clique
 *   external_id      -> nosso identificador de primeira parte
 *   ip, user_agent   -> capturados pelo coletor no momento do clique
 *   ct, st, zp       -> só quando o gateway envia endereço; muitos não enviam
 *
 * O CAPI aceita payload parcial em silêncio: chave mal formatada é descartada
 * sem erro na resposta. Por isso tudo passa por core/hash.ts antes, e por isso
 * devolvemos a lista de chaves realmente enviadas em vez de supor.
 */

import type {
  ResultadoTeste,
  DestinationAdapter, DispatchInput, DestinationConfig, DispatchResult, ConversionEvent,
} from "./types";
import {
  normalizeEmail, normalizePhone, normalizeZip, normalizeCity,
  normalizeState, normalizeCountry, normalizeBirthdate, normalizeGender,
  splitName, hashOrUndefined, sha256,
} from "../core/hash";
import { isValidFbc, isValidFbp } from "../core/identity";
import { META_GRAPH, META_GRAPH_URL } from "../core/versoes";

/** Nossos nomes canônicos -> nomes padrão da Meta. */
const EVENT_NAMES: Record<ConversionEvent, string> = {
  page_view: "PageView",
  view_content: "ViewContent",
  add_to_cart: "AddToCart",
  initiate_checkout: "InitiateCheckout",
  add_payment_info: "AddPaymentInfo",
  purchase: "Purchase",
  lead: "Lead",
  subscribe: "Subscribe",
};

interface MetaUserData {
  em?: string[]; ph?: string[]; fn?: string[]; ln?: string[];
  ct?: string[]; st?: string[]; zp?: string[]; country?: string[];
  db?: string[]; ge?: string[];
  external_id?: string[];
  fbp?: string; fbc?: string;
  client_ip_address?: string; client_user_agent?: string;
}

async function buildUserData(
  input: DispatchInput,
): Promise<{ userData: MetaUserData; matchKeys: string[] }> {
  const ud: MetaUserData = {};
  const keys: string[] = [];
  const c = input.order?.customer;
  const click = input.click;

  const put = (k: keyof MetaUserData, v: string | undefined, label: string) => {
    if (!v) return;
    (ud as Record<string, unknown>)[k] = [v];
    keys.push(label);
  };

  if (c?.email) {
    put("em", await hashOrUndefined(normalizeEmail(c.email)), "em");
  }
  if (c?.phone) {
    put("ph", await hashOrUndefined(normalizePhone(c.phone)), "ph");
  }
  if (c?.name) {
    const { first, last } = splitName(c.name);
    put("fn", await hashOrUndefined(first), "fn");
    put("ln", await hashOrUndefined(last), "ln");
  }
  if (c?.city) put("ct", await hashOrUndefined(normalizeCity(c.city)), "ct");
  if (c?.state) put("st", await hashOrUndefined(normalizeState(c.state)), "st");
  if (c?.zip) put("zp", await hashOrUndefined(normalizeZip(c.zip)), "zp");
  if (c?.country) put("country", await hashOrUndefined(normalizeCountry(c.country)), "country");

  /*
   * Nascimento e gênero raramente chegam do gateway — quase sempre vêm da
   * loja, pela reivindicação. São duas chaves a mais quando existem, e nada
   * quando não existem.
   */
  if (c?.birthdate) put("db", await hashOrUndefined(normalizeBirthdate(c.birthdate)), "db");
  if (c?.gender) put("ge", await hashOrUndefined(normalizeGender(c.gender)), "ge");

  /*
   * external_id é o identificador de primeira parte mais subestimado que
   * existe. Não depende de o comprador ter preenchido nada, sobrevive a
   * bloqueio de cookie de terceiros, e liga eventos anônimos de navegação à
   * compra que veio depois.
   *
   * A Meta aceita vários, e vale mandar todos os que temos: cada um é uma
   * chance a mais de reconhecer a mesma pessoa. Os dois têm forças diferentes.
   * O id de sessão identifica o navegador e some quando a pessoa troca de
   * aparelho; o CPF identifica a pessoa e atravessa aparelho, navegador e
   * limpeza de cookie — é o que faz um comprador recorrente ser reconhecido na
   * segunda compra mesmo vindo de outro celular.
   */
  const externalIds: string[] = [];

  if (click?.clickId) externalIds.push(await sha256(click.clickId));

  if (c?.document) {
    const doc = c.document.replace(/\D/g, "");
    /* 11 dígitos é CPF, 14 é CNPJ; menos que isso é lixo de formulário. */
    if (doc.length === 11 || doc.length === 14) externalIds.push(await sha256(doc));
  }

  /* Sem sessão nem documento, o e-mail hasheado ainda serve de âncora. */
  if (externalIds.length === 0 && c?.email) {
    const em = normalizeEmail(c.email);
    if (em) externalIds.push(await sha256(em));
  }

  if (externalIds.length) {
    ud.external_id = externalIds;
    keys.push("external_id");
  }

  /* Não hasheados — a Meta os quer em claro. Formato inválido é pior que ausente. */
  if (isValidFbp(click?.fbp)) { ud.fbp = click!.fbp; keys.push("fbp"); }
  if (isValidFbc(click?.fbc)) { ud.fbc = click!.fbc; keys.push("fbc"); }
  if (click?.ip) { ud.client_ip_address = click.ip; keys.push("ip"); }
  if (click?.userAgent) { ud.client_user_agent = click.userAgent; keys.push("user_agent"); }

  return { userData: ud, matchKeys: keys };
}

function buildCustomData(input: DispatchInput): Record<string, unknown> {
  const order = input.order;
  const cents = input.valueCents ?? order?.grossCents ?? 0;
  const data: Record<string, unknown> = {
    currency: (input.currency ?? order?.currency ?? "BRL").toUpperCase(),
    value: cents / 100,
  };

  if (order) {
    data.order_id = order.gatewayOrderId;
    const items = order.items.filter((i) => i.sku);
    if (items.length) {
      data.content_type = "product";
      data.content_ids = items.map((i) => i.sku);
      data.contents = items.map((i) => ({
        id: i.sku,
        quantity: i.quantity,
        item_price: i.unitPriceCents / 100,
      }));
      data.num_items = items.reduce((s, i) => s + i.quantity, 0);
    }
  } else if (input.contents?.length) {
    /* Evento de navegação: os produtos vêm soltos, sem pedido por trás. */
    data.content_type = "product";
    data.content_ids = input.contents.map((c) => c.id);
    data.contents = input.contents.map((c) => ({
      id: c.id,
      quantity: c.quantity ?? 1,
      ...(c.priceCents !== undefined ? { item_price: c.priceCents / 100 } : {}),
    }));
    data.num_items = input.contents.reduce((s, c) => s + (c.quantity ?? 1), 0);
  }
  return data;
}

export const metaAdapter: DestinationAdapter = {
  platform: "meta",
  label: "Meta Conversions API",
  supports: [
    "page_view", "view_content", "add_to_cart", "initiate_checkout",
    "add_payment_info", "purchase", "lead", "subscribe",
  ],

  async send(input: DispatchInput, cfg: DestinationConfig): Promise<DispatchResult> {
    const token = cfg.credentials.accessToken;
    if (!token) {
      return { ok: false, matchKeys: [], error: "sem access token", retryable: false };
    }

    const { userData, matchKeys } = await buildUserData(input);

    /*
     * A Meta rejeita eventos com mais de sete dias. Um webhook reprocessado
     * depois desse prazo não vira erro útil — vira dado perdido em silêncio,
     * então é melhor recusar aqui e deixar registrado.
     */
    const eventTime = Math.floor(input.occurredAt.getTime() / 1000);
    const ageDays = (Date.now() / 1000 - eventTime) / 86400;
    if (ageDays > 7) {
      return {
        ok: false, matchKeys,
        error: `evento com ${ageDays.toFixed(1)} dias, fora da janela de 7 dias`,
        retryable: false,
      };
    }

    const body = {
      data: [{
        event_name: EVENT_NAMES[input.event],
        event_time: eventTime,
        event_id: input.eventId,
        event_source_url: input.sourceUrl,
        /*
         * "website" mesmo quando o disparo nasce do webhook: a ação do
         * comprador aconteceu num site. Marcar como "system_generated" faria
         * a Meta tratar a conversão como offline e descontar a atribuição.
         */
        action_source: "website",
        user_data: userData,
        custom_data: buildCustomData(input),
      }],
      ...(cfg.testEventCode ? { test_event_code: cfg.testEventCode } : {}),
    };

    const url = `${META_GRAPH_URL}/${cfg.externalId}/events`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        return {
          ok: false, matchKeys, requestBody: body, responseBody: json,
          error: `HTTP ${res.status}`,
          /* 5xx e 429 passam; 4xx de payload não adianta repetir. */
          retryable: res.status >= 500 || res.status === 429,
        };
      }
      return { ok: true, matchKeys, requestBody: body, responseBody: json };
    } catch (e) {
      return {
        ok: false, matchKeys, requestBody: body,
        error: e instanceof Error ? e.message : String(e),
        retryable: true,
      };
    }
  },

  async reenviar(corpo: unknown, cfg: DestinationConfig): Promise<DispatchResult> {
    const token = cfg.credentials.accessToken;
    if (!token) return { ok: false, matchKeys: [], error: "sem access token", retryable: false };

    /*
     * A janela de sete dias vale no reenvio também, e é a razão de as
     * tentativas pararem em poucas horas: passado o prazo a Meta descarta o
     * evento em silêncio, e insistir só gasta cota.
     */
    const evento = (corpo as { data?: Array<{ event_time?: number }> })?.data?.[0];
    if (evento?.event_time) {
      const dias = (Date.now() / 1000 - evento.event_time) / 86400;
      if (dias > 7) {
        return { ok: false, matchKeys: [], error: "fora da janela de 7 dias", retryable: false };
      }
    }

    try {
      const res = await fetch(
        `${META_GRAPH_URL}/${cfg.externalId}/events`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(corpo),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          ok: false, matchKeys: [], responseBody: json,
          error: `HTTP ${res.status}`,
          retryable: res.status >= 500 || res.status === 429,
        };
      }
      return { ok: true, matchKeys: [], responseBody: json };
    } catch (e) {
      return {
        ok: false, matchKeys: [],
        error: e instanceof Error ? e.message : String(e), retryable: true,
      };
    }
  },

  /*
   * Lê o próprio pixel. É a chamada mais barata que prova as três coisas de
   * uma vez: a versão da URL existe, o token vale, e o token enxerga ESTE
   * pixel — que é diferente de valer para a conta.
   *
   * O terceiro ponto é o que mais aparece na prática: token legítimo, de uma
   * conta que não administra aquele pixel. A Meta devolve 200 no disparo e
   * descarta o evento, então sem esta leitura o erro é invisível.
   */
  async testar(cfg: DestinationConfig): Promise<ResultadoTeste> {
    const token = cfg.credentials.accessToken;
    if (!token) return { ok: false, detalhe: "sem access token cadastrado" };

    try {
      const res = await fetch(
        `${META_GRAPH_URL}/${cfg.externalId}?fields=id,name`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      const j = await res.json().catch(() => ({})) as {
        name?: string; id?: string; error?: { message?: string; code?: number };
      };

      if (!res.ok || j.error) {
        const msg = j.error?.message ?? `HTTP ${res.status}`;
        /*
         * O código 100 com subcódigo de versão é o sintoma de versão morta na
         * URL, e ele NÃO se parece com erro de versão — a Meta diz "Unsupported
         * get request", que se lê como pixel inexistente. Nomear aqui evita a
         * caça ao pixel errado depois de uma troca em core/versoes.ts.
         */
        return { ok: false, detalhe: `${msg} (versão ${META_GRAPH})` };
      }
      /*
       * A VERSÃO sai junto no sucesso, não só no erro.
       *
       * Ela é a única forma de responder "qual versão a produção está usando
       * agora?" sem abrir o painel da Vercel — e a pergunta aparece toda vez
       * que alguém desconfia de um número. A constante do repositório diz o
       * padrão; uma variável de ambiente esquecida a sobrepõe em silêncio, e
       * daí só a resposta da plataforma sabe a verdade.
       */
      const quem = j.name ? `pixel "${j.name}"` : `pixel ${j.id ?? cfg.externalId}`;
      return { ok: true, detalhe: `${quem} — Graph ${META_GRAPH}` };
    } catch (e) {
      return { ok: false, detalhe: e instanceof Error ? e.message : String(e) };
    }
  },
};
