/*
 * GA4 — Measurement Protocol, e SÓ para a compra.
 *
 * Este adaptador é deliberadamente o mais estreito dos quatro, e a estreiteza é
 * a funcionalidade principal. Leia antes de ampliar.
 *
 * O GA4 tem duas portas de entrada, e elas NÃO se substituem:
 *
 *   gtag.js, no navegador, manda tudo que acontece na página. Ele já roda no
 *   site (ver public/rr.js), cria o cookie `_ga`, mantém a sessão, sabe a
 *   resolução da tela e a referência — coisas que o servidor não tem.
 *
 *   Measurement Protocol, daqui, manda o que NÃO acontece na página. Que é
 *   exatamente um evento: a compra, que nasce quando o gateway avisa que
 *   alguém pagou, horas depois de o navegador ter fechado.
 *
 * Mandar por aqui um `view_item` que o gtag já mandou não enriquece nada: o
 * GA4 conta os DOIS. O relatório dobra, a taxa de conversão cai pela metade, e
 * não há erro em lugar nenhum para investigar — só um número que parou de
 * bater com a realidade. É por isso que `supports` tem um item só, e por isso
 * que acrescentar outro exige antes responder "e o gtag para de mandar esse?".
 *
 * O `client_id` vem do cookie `_ga`, coletado pelo rr.js e guardado na sessão
 * de clique. Sem ele a compra chega como usuário novo, sem origem, e o funil
 * quebra no último passo — justamente o que se queria medir.
 */

import type {
  ResultadoTeste,
  DestinationAdapter, DispatchInput, DestinationConfig, DispatchResult, ConversionEvent,
} from "./types";

/*
 * O Measurement Protocol não põe versão na URL, diferente da Meta e do Google
 * Ads — então não há constante em core/versoes.ts para ele. O que muda entre
 * versões é o conjunto de parâmetros aceitos, e parâmetro desconhecido é
 * ignorado em silêncio, nunca recusado.
 */
const COLETA = "https://www.google-analytics.com/mp/collect";
const COLETA_DEBUG = "https://www.google-analytics.com/debug/mp/collect";

/*
 * Sem `engagement_time_msec` o evento CHEGA mas não aparece no Realtime nem
 * conta para engajamento. A documentação do Google é explícita, e o sintoma de
 * esquecer é o pior tipo: a API responde 204, tudo parece certo, e o evento
 * simplesmente não existe nos relatórios que a pessoa vai abrir para conferir.
 *
 * Um milissegundo é o mínimo honesto para um evento de servidor: não houve
 * engajamento nenhum nesta página, porque não houve página.
 */
const ENGAJAMENTO_MS = "1";

export const ga4Adapter: DestinationAdapter = {
  platform: "ga4",
  label: "Google Analytics 4",

  /*
   * UM evento. Ver o cabeçalho: o resto vai por gtag.js, no navegador, e
   * duplicar aqui faria o GA4 contar duas vezes sem avisar ninguém.
   */
  supports: ["purchase"] as ConversionEvent[],

  async send(input: DispatchInput, cfg: DestinationConfig): Promise<DispatchResult> {
    const apiSecret = cfg.credentials.apiSecret;
    if (!apiSecret) {
      return { ok: false, matchKeys: [], error: "sem api secret", retryable: false };
    }

    /*
     * `client_id` é obrigatório e NÃO pode ser inventado.
     *
     * Gerar um aqui criaria um usuário novo a cada compra: o GA4 contaria uma
     * pessoa diferente por venda, a taxa de conversão iria ao teto, e a origem
     * do tráfego se perderia — porque quem tinha a origem era a sessão do
     * navegador, que ficou com o outro id.
     *
     * Recusar é melhor: a venda fica registrada como não enviada, com o motivo
     * na tela, e alguém conserta a coleta do `_ga` em vez de olhar um relatório
     * que mente.
     */
    const clientId = input.click?.gaClientId;
    if (!clientId) {
      return {
        ok: false,
        matchKeys: [],
        error: "sem client_id do GA4 — o _ga não foi coletado nesta sessão",
        retryable: false,
      };
    }

    const order = input.order;
    const cents = input.valueCents ?? order?.grossCents ?? 0;

    const params: Record<string, unknown> = {
      currency: (input.currency ?? order?.currency ?? "BRL").toUpperCase(),
      value: cents / 100,
      engagement_time_msec: ENGAJAMENTO_MS,
    };

    /*
     * `transaction_id` é o que o GA4 usa para deduplicar compra. Sem ele, uma
     * reentrega do webhook vira receita dobrada no relatório — e a nossa
     * proteção por índice único não ajuda, porque ela impede o disparo
     * REPETIDO, não o reprocessamento legítimo depois de uma correção.
     */
    if (order) {
      params.transaction_id = order.gatewayOrderId;
      const itens = order.items.filter((i) => i.sku);
      if (itens.length) {
        params.items = itens.map((i) => ({
          item_id: i.sku,
          item_name: i.name,
          quantity: i.quantity,
          price: i.unitPriceCents / 100,
        }));
      }
    }

    /*
     * A sessão do navegador, quando conhecida.
     *
     * Só cola se o evento chegar dentro de 24 h do início dela; passado isso o
     * GA4 ignora o campo e usa a sessão mais recente daquele cliente. Mandar
     * assim mesmo é de graça e não atrapalha — o que atrapalharia é inventar
     * um número, que faria o GA4 abrir uma sessão que nunca existiu.
     */
    const sessionId = input.click?.gaSessionId;
    if (sessionId) params.session_id = sessionId;

    /*
     * Chaves de correspondência, no sentido que o painel usa: o que FOI
     * enviado para a plataforma poder reconhecer a pessoa. No GA4 isso é o
     * client_id e, quando há, a sessão. Não existe hash de e-mail aqui —
     * user-provided data é outra API, com outro consentimento.
     */
    const matchKeys = ["client_id", ...(sessionId ? ["session_id"] : [])];

    const body = {
      client_id: clientId,
      events: [{ name: "purchase", params }],
    };

    /*
     * O `test_event_code` da Meta tem equivalente aqui, mas o mecanismo é
     * outro: em vez de uma aba separada, o GA4 tem um ENDPOINT de depuração
     * que valida o payload e devolve os problemas — e não registra nada. Útil
     * para conferir antes de ligar, e é o que o botão "Testar conexão" usa.
     */
    const url = `${COLETA}?measurement_id=${encodeURIComponent(cfg.externalId)}`
      + `&api_secret=${encodeURIComponent(apiSecret)}`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      /*
       * O MP responde 204 SEM CORPO quando aceita, e 204 sem corpo também
       * quando o payload está errado — ele não valida na coleta. Por isso o
       * `ok` aqui significa "a chamada saiu", e a prova de que o conteúdo está
       * certo é o endpoint de depuração, que o botão de teste usa.
       */
      if (!res.ok) {
        return {
          ok: false, matchKeys, requestBody: body,
          error: `HTTP ${res.status}`,
          retryable: res.status >= 500 || res.status === 429,
        };
      }
      return {
        ok: true, matchKeys, requestBody: body,
        responseBody: { status: res.status, nota: "o MP não confirma conteúdo; ver /debug" },
      };
    } catch (e) {
      return {
        ok: false, matchKeys, requestBody: body,
        error: e instanceof Error ? e.message : String(e),
        retryable: true,
      };
    }
  },

  async reenviar(corpo: unknown, cfg: DestinationConfig): Promise<DispatchResult> {
    const apiSecret = cfg.credentials.apiSecret;
    if (!apiSecret) return { ok: false, matchKeys: [], error: "sem api secret", retryable: false };

    const url = `${COLETA}?measurement_id=${encodeURIComponent(cfg.externalId)}`
      + `&api_secret=${encodeURIComponent(apiSecret)}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(corpo),
      });
      if (!res.ok) {
        return {
          ok: false, matchKeys: [],
          error: `HTTP ${res.status}`,
          retryable: res.status >= 500 || res.status === 429,
        };
      }
      return { ok: true, matchKeys: [], responseBody: { status: res.status } };
    } catch (e) {
      return {
        ok: false, matchKeys: [],
        error: e instanceof Error ? e.message : String(e), retryable: true,
      };
    }
  },

  /*
   * Usa o endpoint de DEPURAÇÃO, que é o único que valida.
   *
   * A coleta normal devolve 204 para qualquer coisa — inclusive para
   * measurement_id inexistente e api_secret errado. Um teste contra ela diria
   * "funcionou" com a credencial trocada, que é pior que não testar: daria
   * confiança falsa exatamente onde a pessoa foi buscar confiança.
   *
   * O /debug devolve `validationMessages`, e NÃO registra o evento — então o
   * teste não suja o relatório com uma compra que não houve.
   */
  async testar(cfg: DestinationConfig): Promise<ResultadoTeste> {
    const apiSecret = cfg.credentials.apiSecret;
    if (!apiSecret) return { ok: false, detalhe: "sem api secret cadastrado" };

    const url = `${COLETA_DEBUG}?measurement_id=${encodeURIComponent(cfg.externalId)}`
      + `&api_secret=${encodeURIComponent(apiSecret)}`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          /* Id de teste fixo: não polui o relatório e é reconhecível no debug. */
          client_id: "555.555",
          events: [{ name: "purchase", params: {
            currency: "BRL", value: 1, transaction_id: "teste-rrtrack",
            engagement_time_msec: ENGAJAMENTO_MS,
          } }],
        }),
      });

      const j = await res.json().catch(() => ({})) as {
        validationMessages?: Array<{ description?: string; validationCode?: string }>;
      };

      if (!res.ok) return { ok: false, detalhe: `HTTP ${res.status}` };

      const problemas = j.validationMessages ?? [];
      if (problemas.length) {
        return {
          ok: false,
          detalhe: problemas.map((m) => m.description ?? m.validationCode ?? "?").join("; "),
        };
      }
      return { ok: true, detalhe: `payload aceito por ${cfg.externalId} (via /debug, nada foi registrado)` };
    } catch (e) {
      return { ok: false, detalhe: e instanceof Error ? e.message : String(e) };
    }
  },
};
