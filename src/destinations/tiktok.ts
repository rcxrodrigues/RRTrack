/*
 * TikTok Events API 2.0.
 *
 * Mesmo trabalho que o CAPI da Meta — mandar a conversão pelo servidor com o
 * máximo de chaves de correspondência — mas com três diferenças que, se
 * ignoradas, fazem o evento chegar e não casar com ninguém:
 *
 * 1. O TELEFONE VAI COM O SINAL DE MAIS. A Meta quer "5511999998888"; o TikTok
 *    quer "+5511999998888". Hash de string diferente é hash diferente, então
 *    reaproveitar a normalização da Meta aqui derrubaria a correspondência de
 *    telefone inteira, sem erro nenhum aparecendo.
 *
 * 2. ELE HASHEIA CIDADE, ESTADO, PAÍS E CEP. A Meta também, mas o TikTok
 *    hasheia até o `external_id`, que na Meta pode ir em claro.
 *
 * 3. ERRO VEM COM HTTP 200. A resposta traz `code: 0` para sucesso e outro
 *    número para falha, com a mensagem dentro. Confiar no status HTTP faria
 *    todo evento recusado parecer entregue — e o painel mostraria uma saúde
 *    que não existe.
 *
 * O `ttclid` é para o TikTok o que o `fbc` é para a Meta: o identificador do
 * clique no anúncio, e a chave mais valiosa que existe para tráfego pago dele.
 * O `rr.js` já o captura da URL desde o primeiro dia.
 */

import type {
  ResultadoTeste,
  DestinationAdapter, DispatchInput, DestinationConfig, DispatchResult, ConversionEvent,
} from "./types";
import {
  normalizeEmail, normalizePhone, normalizeZip, normalizeCity,
  normalizeState, normalizeCountry, splitName, hashOrUndefined, sha256,
} from "../core/hash";

const ENDPOINT = "https://business-api.tiktok.com/open_api/v1.3/event/track/";

/** Nossos nomes canônicos -> nomes padrão do TikTok. */
const EVENTOS: Record<ConversionEvent, string> = {
  page_view: "Pageview",
  view_content: "ViewContent",
  add_to_cart: "AddToCart",
  initiate_checkout: "InitiateCheckout",
  add_payment_info: "AddPaymentInfo",
  purchase: "CompletePayment",
  lead: "Lead",
  subscribe: "Subscribe",
};

interface UsuarioTikTok {
  email?: string; phone?: string; external_id?: string;
  first_name?: string; last_name?: string;
  city?: string; state?: string; country?: string; zip_code?: string;
  ttclid?: string; ttp?: string;
  ip?: string; user_agent?: string;
}

/*
 * Telefone no formato do TikTok: E.164 COM o sinal de mais.
 *
 * Reaproveita a normalização brasileira — que resolve DDI ausente, zero de
 * discagem e pontuação — e só acrescenta o prefixo. Duplicar aquela lógica
 * aqui seria pedir para as duas divergirem com o tempo.
 */
function telefoneTikTok(bruto: string): string | null {
  const digitos = normalizePhone(bruto);
  return digitos ? "+" + digitos : null;
}

async function montarUsuario(
  input: DispatchInput,
): Promise<{ user: UsuarioTikTok; matchKeys: string[] }> {
  const u: UsuarioTikTok = {};
  const keys: string[] = [];
  const c = input.order?.customer;
  const click = input.click;

  const put = (k: keyof UsuarioTikTok, v: string | undefined, rotulo: string) => {
    if (!v) return;
    (u as Record<string, unknown>)[k] = v;
    keys.push(rotulo);
  };

  if (c?.email) put("email", await hashOrUndefined(normalizeEmail(c.email)), "email");
  if (c?.phone) put("phone", await hashOrUndefined(telefoneTikTok(c.phone)), "phone");

  if (c?.name) {
    const { first, last } = splitName(c.name);
    put("first_name", await hashOrUndefined(first), "first_name");
    put("last_name", await hashOrUndefined(last), "last_name");
  }

  if (c?.city) put("city", await hashOrUndefined(normalizeCity(c.city)), "city");
  if (c?.state) put("state", await hashOrUndefined(normalizeState(c.state)), "state");
  if (c?.country) put("country", await hashOrUndefined(normalizeCountry(c.country)), "country");
  if (c?.zip) put("zip_code", await hashOrUndefined(normalizeZip(c.zip)), "zip_code");

  /*
   * Um external_id só, ao contrário da Meta que aceita vários. O da sessão é
   * preferido: ele existe em todo evento, inclusive nos de navegação, onde
   * ainda não há comprador identificado. O CPF só entra quando não há sessão.
   */
  if (click?.clickId) {
    put("external_id", await sha256(click.clickId), "external_id");
  } else if (c?.document) {
    const doc = c.document.replace(/\D/g, "");
    if (doc.length === 11 || doc.length === 14) {
      put("external_id", await sha256(doc), "external_id");
    }
  }

  /* Não hasheados. O ttclid é o equivalente do fbc aqui. */
  if (click?.ttclid) put("ttclid", click.ttclid, "ttclid");
  if (click?.ip) put("ip", click.ip, "ip");
  if (click?.userAgent) put("user_agent", click.userAgent, "user_agent");

  return { user: u, matchKeys: keys };
}

function montarPropriedades(input: DispatchInput): Record<string, unknown> {
  const order = input.order;
  const cents = input.valueCents ?? order?.grossCents ?? 0;

  const props: Record<string, unknown> = {
    currency: (input.currency ?? order?.currency ?? "BRL").toUpperCase(),
    value: cents / 100,
  };

  const itens = order
    ? order.items.filter((i) => i.sku).map((i) => ({
        content_id: i.sku,
        content_type: "product",
        content_name: i.name,
        quantity: i.quantity,
        price: i.unitPriceCents / 100,
      }))
    : (input.contents ?? []).map((c) => ({
        content_id: c.id,
        content_type: "product",
        content_name: c.name,
        quantity: c.quantity ?? 1,
        ...(c.priceCents !== undefined ? { price: c.priceCents / 100 } : {}),
      }));

  if (itens.length) {
    props.contents = itens;
    props.content_type = "product";
  }
  if (order) props.order_id = order.gatewayOrderId;

  return props;
}

export const tiktokAdapter: DestinationAdapter = {
  platform: "tiktok",
  label: "TikTok Events API",
  supports: [
    "page_view", "view_content", "add_to_cart", "initiate_checkout",
    "add_payment_info", "purchase", "lead", "subscribe",
  ],

  async send(input: DispatchInput, cfg: DestinationConfig): Promise<DispatchResult> {
    const token = cfg.credentials.accessToken;
    if (!token) {
      return { ok: false, matchKeys: [], error: "sem access token", retryable: false };
    }

    const { user, matchKeys } = await montarUsuario(input);

    const corpo = {
      event_source: "web",
      /* Para o TikTok isto é o código do pixel. */
      event_source_id: cfg.externalId,
      ...(cfg.testEventCode ? { test_event_code: cfg.testEventCode } : {}),
      data: [{
        event: EVENTOS[input.event],
        /* Segundos, não milissegundos — mandar ms joga o evento para o ano 55 mil. */
        event_time: Math.floor(input.occurredAt.getTime() / 1000),
        /* Mesmo id da Meta: é o que deduplica se houver pixel no navegador. */
        event_id: input.eventId,
        user,
        properties: montarPropriedades(input),
        page: input.sourceUrl ? { url: input.sourceUrl } : undefined,
      }],
    };

    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Access-Token": token,
        },
        body: JSON.stringify(corpo),
      });

      const json = await res.json().catch(() => ({})) as { code?: number; message?: string };

      if (!res.ok) {
        return {
          ok: false, matchKeys, requestBody: corpo, responseBody: json,
          error: `HTTP ${res.status}`,
          retryable: res.status >= 500 || res.status === 429,
        };
      }

      /*
       * Aqui é onde o TikTok difere de todo mundo: HTTP 200 com erro dentro.
       * `code` diferente de zero é recusa, e tratar como sucesso faria o painel
       * mostrar uma saúde de envio que não existe.
       */
      if (typeof json.code === "number" && json.code !== 0) {
        return {
          ok: false, matchKeys, requestBody: corpo, responseBody: json,
          error: `TikTok code ${json.code}: ${json.message ?? "sem mensagem"}`,
          /* 40100 é limite de chamadas; o resto costuma ser payload ou token. */
          retryable: json.code === 40100,
        };
      }

      return { ok: true, matchKeys, requestBody: corpo, responseBody: json };
    } catch (e) {
      return {
        ok: false, matchKeys, requestBody: corpo,
        error: e instanceof Error ? e.message : String(e),
        retryable: true,
      };
    }
  },

  async reenviar(corpo: unknown, cfg: DestinationConfig): Promise<DispatchResult> {
    const token = cfg.credentials.accessToken;
    if (!token) return { ok: false, matchKeys: [], error: "sem access token", retryable: false };

    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", "Access-Token": token },
        body: JSON.stringify(corpo),
      });
      const json = await res.json().catch(() => ({})) as { code?: number; message?: string };

      if (!res.ok) {
        return {
          ok: false, matchKeys: [], responseBody: json,
          error: `HTTP ${res.status}`,
          retryable: res.status >= 500 || res.status === 429,
        };
      }

      /* A recusa continua vindo dentro do 200, também no reenvio. */
      if (typeof json.code === "number" && json.code !== 0) {
        return {
          ok: false, matchKeys: [], responseBody: json,
          error: `TikTok code ${json.code}: ${json.message ?? "sem mensagem"}`,
          retryable: json.code === 40100,
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
   * Confere o token, e SÓ o token.
   *
   * O ideal seria ler o pixel, como no adaptador da Meta. Não dá: o endpoint
   * de pixel do TikTok exige `advertiser_id`, e um destino aqui guarda o
   * código do pixel, não a conta de anúncio a que ele pertence — são tabelas
   * diferentes, e a mesma loja pode ter uma sem a outra.
   *
   * Então este teste responde "o token vale" e não responde "o token enxerga
   * este pixel". A diferença está dita no texto que volta, para ninguém ler um
   * verde aqui como garantia que ele não dá.
   */
  async testar(cfg: DestinationConfig): Promise<ResultadoTeste> {
    const token = cfg.credentials.accessToken;
    if (!token) return { ok: false, detalhe: "sem access token cadastrado" };

    try {
      const res = await fetch("https://business-api.tiktok.com/open_api/v1.3/user/info/", {
        headers: { "Access-Token": token },
      });
      const j = await res.json().catch(() => ({})) as {
        code?: number; message?: string; data?: { display_name?: string; email?: string };
      };

      /*
       * O TikTok responde 200 com `code` diferente de zero para erro de
       * credencial. Conferir só o status HTTP daria verde para token vencido.
       */
      if (!res.ok || (j.code ?? 0) !== 0) {
        return { ok: false, detalhe: j.message ?? `HTTP ${res.status}` };
      }
      const quem = j.data?.display_name ?? j.data?.email ?? "conta";
      return { ok: true, detalhe: `token válido (${quem}) — não confere o vínculo com o pixel` };
    } catch (e) {
      return { ok: false, detalhe: e instanceof Error ? e.message : String(e) };
    }
  },
};
