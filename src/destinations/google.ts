/*
 * Google Ads — envio de conversão por clique.
 *
 * Aqui o desenho é diferente das outras duas, e a diferença não é de formato:
 * é de modelo.
 *
 * Meta e TikTok recebem qualquer evento e tentam achar a pessoa pelas chaves.
 * O Google parte do CLIQUE: sem `gclid` (ou `gbraid`/`wbraid` no caminho de
 * app), não há a que amarrar a conversão, e o envio não faz sentido nenhum. As
 * chaves de pessoa entram como reforço — as "enhanced conversions" — e não
 * como o mecanismo principal.
 *
 * Consequência prática: só faz sentido enviar VENDA, e só quando o clique veio
 * do Google. Evento de navegação sem gclid é descartado antes de sair, em vez
 * de virar uma chamada que a API recusaria.
 *
 * Três armadilhas próprias:
 *
 * 1. `userIdentifiers` é uma lista de OBJETOS COM UM CAMPO CADA. Mandar
 *    e-mail e telefone no mesmo objeto faz o Google ignorar um dos dois em
 *    silêncio — é um `oneof` no protocolo.
 *
 * 2. E-MAIL DO GMAIL PERDE PONTOS E SUFIXO. Para o Google, `jo.se+loja@` e
 *    `jose@` são a mesma caixa. Usar a normalização da Meta aqui geraria hash
 *    que nunca casa, justamente nos endereços mais comuns do Brasil.
 *
 * 3. A DATA VAI COM FUSO EXPLÍCITO, no formato "AAAA-MM-DD HH:MM:SS+HH:MM".
 *    Sem o fuso, o Google recusa a conversão inteira.
 */

import type {
  ResultadoTeste,
  DestinationAdapter, DispatchInput, DestinationConfig, DispatchResult, ConversionEvent,
} from "./types";
import {
  normalizeEmailGoogle, normalizePhoneE164, normalizeZip, normalizeCity,
  normalizeState, normalizeCountry, splitName, hashOrUndefined,
} from "../core/hash";
import { accessToken, cabecalhos, soDigitos, VERSAO } from "../ads/google-auth";

/*
 * Fuso das conversões. O Google exige o deslocamento explícito e não aceita
 * "Z" nem nome de região — tem de ser o formato numérico.
 */
const FUSO = process.env.GOOGLE_ADS_TIMEZONE_OFFSET ?? "-03:00";

function dataGoogle(d: Date): string {
  /*
   * Constrói no horário de Brasília e carimba o deslocamento. Usar UTC com
   * "+00:00" também seria aceito, mas jogaria a venda da madrugada para o dia
   * seguinte nos relatórios do Google, que agrupa pelo fuso da conta.
   */
  const local = new Date(d.getTime() - 3 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())} `
    + `${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(local.getUTCSeconds())}${FUSO}`;
}

interface Identificador {
  hashedEmail?: string;
  hashedPhoneNumber?: string;
  addressInfo?: {
    hashedFirstName?: string;
    hashedLastName?: string;
    city?: string;
    state?: string;
    countryCode?: string;
    postalCode?: string;
  };
}

async function identificadores(
  input: DispatchInput,
): Promise<{ lista: Identificador[]; matchKeys: string[] }> {
  const lista: Identificador[] = [];
  const keys: string[] = [];
  const c = input.order?.customer;
  if (!c) return { lista, matchKeys: keys };

  /*
   * Um objeto por identificador. É `oneof` no protocolo: dois campos no mesmo
   * objeto e o Google fica com um só, sem avisar qual.
   */
  if (c.email) {
    const h = await hashOrUndefined(normalizeEmailGoogle(c.email));
    if (h) { lista.push({ hashedEmail: h }); keys.push("email"); }
  }

  if (c.phone) {
    const h = await hashOrUndefined(normalizePhoneE164(c.phone));
    if (h) { lista.push({ hashedPhoneNumber: h }); keys.push("phone"); }
  }

  /*
   * Endereço vai num identificador só, e é o único lugar onde o Google quer
   * dado EM CLARO: cidade, estado, país e CEP não são hasheados. Só nome e
   * sobrenome são.
   */
  const { first, last } = c.name ? splitName(c.name) : { first: undefined, last: undefined };
  const endereco: Identificador["addressInfo"] = {};
  let temEndereco = false;

  if (first) { endereco.hashedFirstName = await hashOrUndefined(first); temEndereco = true; keys.push("first_name"); }
  if (last) { endereco.hashedLastName = await hashOrUndefined(last); temEndereco = true; keys.push("last_name"); }
  if (c.city) { endereco.city = normalizeCity(c.city) ?? undefined; temEndereco = true; keys.push("city"); }
  if (c.state) { endereco.state = normalizeState(c.state) ?? undefined; temEndereco = true; keys.push("state"); }
  if (c.country) { endereco.countryCode = (normalizeCountry(c.country) ?? "br").toUpperCase(); temEndereco = true; keys.push("country"); }
  if (c.zip) { endereco.postalCode = normalizeZip(c.zip) ?? undefined; temEndereco = true; keys.push("zip"); }

  if (temEndereco) lista.push({ addressInfo: endereco });

  return { lista, matchKeys: keys };
}

export const googleAdapter: DestinationAdapter = {
  platform: "google",
  label: "Google Ads",

  /*
   * Só compra. O Google recebe conversão amarrada a um clique dele; evento de
   * navegação não tem onde encaixar e seria recusado.
   */
  supports: ["purchase", "lead", "subscribe"] as ConversionEvent[],

  async send(input: DispatchInput, cfg: DestinationConfig): Promise<DispatchResult> {
    const cred = cfg.credentials;
    const acaoConversao = (cfg.config?.conversionAction as string) ?? cred.conversionAction;

    if (!acaoConversao) {
      return {
        ok: false, matchKeys: [], retryable: false,
        error: "sem ação de conversão configurada — crie uma do tipo 'importar cliques' no Google Ads",
      };
    }

    const click = input.click;
    /*
     * Sem identificador de clique do Google não há conversão a registrar.
     * Descartar aqui é melhor que mandar e levar recusa: economiza a chamada e
     * deixa o motivo explícito no histórico de disparos.
     */
    const gclid = click?.gclid;
    const gbraid = click?.gbraid;
    const wbraid = click?.wbraid;

    if (!gclid && !gbraid && !wbraid) {
      return {
        ok: false, matchKeys: [], retryable: false,
        error: "venda sem gclid — não veio de clique no Google",
      };
    }

    let token: string;
    try {
      token = await accessToken(cred);
    } catch (e) {
      return {
        ok: false, matchKeys: [], retryable: false,
        error: e instanceof Error ? e.message : "falha na autenticação do Google",
      };
    }

    const { lista, matchKeys } = await identificadores(input);
    const chaves = [...matchKeys, gclid ? "gclid" : gbraid ? "gbraid" : "wbraid"];

    const conta = soDigitos(cfg.externalId);
    const cents = input.valueCents ?? input.order?.grossCents ?? 0;

    const corpo = {
      conversions: [{
        ...(gclid ? { gclid } : gbraid ? { gbraid } : { wbraid }),
        conversionAction: acaoConversao,
        conversionDateTime: dataGoogle(input.occurredAt),
        conversionValue: cents / 100,
        currencyCode: (input.currency ?? input.order?.currency ?? "BRL").toUpperCase(),
        /* O id do pedido é o que deduplica do lado do Google. */
        ...(input.order ? { orderId: input.order.gatewayOrderId } : {}),
        ...(lista.length ? { userIdentifiers: lista } : {}),
      }],
      /*
       * Falha parcial: uma conversão ruim não derruba o lote. Com lote de uma
       * só muda pouco, mas o Google EXIGE o campo quando há userIdentifiers.
       */
      partialFailure: true,
    };

    try {
      const res = await fetch(
        `https://googleads.googleapis.com/${VERSAO}/customers/${conta}:uploadClickConversions`,
        { method: "POST", headers: cabecalhos(token, cred), body: JSON.stringify(corpo) },
      );

      const json = await res.json().catch(() => ({})) as {
        partialFailureError?: { message?: string };
        results?: unknown[];
      };

      if (!res.ok) {
        return {
          ok: false, matchKeys: chaves, requestBody: corpo, responseBody: json,
          error: `HTTP ${res.status}`,
          retryable: res.status >= 500 || res.status === 429,
        };
      }

      /*
       * Com `partialFailure`, o Google devolve HTTP 200 e coloca a recusa em
       * `partialFailureError`. Ignorar esse campo faria conversão rejeitada
       * contar como entregue.
       */
      if (json.partialFailureError?.message) {
        return {
          ok: false, matchKeys: chaves, requestBody: corpo, responseBody: json,
          error: `Google recusou: ${json.partialFailureError.message}`,
          retryable: false,
        };
      }

      return { ok: true, matchKeys: chaves, requestBody: corpo, responseBody: json };
    } catch (e) {
      return {
        ok: false, matchKeys: chaves, requestBody: corpo,
        error: e instanceof Error ? e.message : String(e),
        retryable: true,
      };
    }
  },

  async reenviar(corpo: unknown, cfg: DestinationConfig): Promise<DispatchResult> {
    let token: string;
    try {
      token = await accessToken(cfg.credentials);
    } catch (e) {
      return {
        ok: false, matchKeys: [], retryable: false,
        error: e instanceof Error ? e.message : "falha na autenticação do Google",
      };
    }

    try {
      const res = await fetch(
        `https://googleads.googleapis.com/${VERSAO}/customers/${soDigitos(cfg.externalId)}:uploadClickConversions`,
        { method: "POST", headers: cabecalhos(token, cfg.credentials), body: JSON.stringify(corpo) },
      );
      const json = await res.json().catch(() => ({})) as { partialFailureError?: { message?: string } };

      if (!res.ok) {
        return {
          ok: false, matchKeys: [], responseBody: json,
          error: `HTTP ${res.status}`,
          retryable: res.status >= 500 || res.status === 429,
        };
      }
      if (json.partialFailureError?.message) {
        return {
          ok: false, matchKeys: [], responseBody: json,
          error: `Google recusou: ${json.partialFailureError.message}`,
          retryable: false,
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
   * Renova o token. Parece pouco, e é o teste mais valioso dos três.
   *
   * O Google é a única das três integrações que NÃO funciona no dia em que se
   * cadastra — precisa de developer token aprovado por eles — e a única cuja
   * credencial morre sozinha: `invalid_grant` chega quando alguém troca a senha
   * da conta Google ou revoga o consentimento, sem nada avisar por aqui.
   *
   * Confere também o `conversionAction`. Sem ele o upload é recusado inteiro, e
   * é o campo que mais some, porque é o único que a pessoa tem de copiar à mão
   * de dentro da interface do Google Ads.
   */
  async testar(cfg: DestinationConfig): Promise<ResultadoTeste> {
    const faltando = (["developerToken", "clientId", "clientSecret", "refreshToken"] as const)
      .filter((k) => !cfg.credentials[k]);
    if (faltando.length) return { ok: false, detalhe: `faltam credenciais: ${faltando.join(", ")}` };
    if (!cfg.credentials.conversionAction) {
      return { ok: false, detalhe: "falta a ação de conversão (conversionAction)" };
    }

    try {
      await accessToken(cfg.credentials);
      return {
        ok: true,
        detalhe: `autorização válida (API ${VERSAO}) — conversão sobe para a conta ${cfg.externalId}`,
      };
    } catch (e) {
      return { ok: false, detalhe: e instanceof Error ? e.message : String(e) };
    }
  },
};
