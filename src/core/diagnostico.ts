/*
 * Diagnóstico da instalação.
 *
 * Existe para o momento em que você acabou de colar o script no site e quer
 * saber se funcionou. Sem isto, a única forma de descobrir é abrir o Events
 * Manager da Meta e adivinhar pelo que aparece lá — o que confunde causa com
 * consequência: o evento pode não ter chegado à Meta porque o script não
 * disparou, porque o coletor recusou, porque o pixel não está configurado, ou
 * porque o token venceu. São quatro problemas diferentes com o mesmo sintoma.
 *
 * A tela separa esses quatro em quatro perguntas, na ordem em que o dado
 * atravessa o sistema. A primeira que falhar é a que importa; as seguintes são
 * consequência.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/index";

async function linhasDe<T>(consulta: Promise<{ rows: T[] }>): Promise<T[]> {
  return (await consulta).rows;
}

export type Estado = "ok" | "atencao" | "parado" | "nunca";

export interface Verificacao {
  etapa: string;
  pergunta: string;
  estado: Estado;
  detalhe: string;
  /* O que fazer quando está errado. Vazio quando está certo. */
  conserto?: string;
}

/**
 * As quatro perguntas, na ordem do caminho do dado.
 */
export async function verificacoes(tenantId: string): Promise<Verificacao[]> {
  const [c] = await linhasDe(db.execute<{
    eventos_24h: number; eventos_total: number; ultimo_evento: string | null;
    sessoes_24h: number;
    entregas_7d: number; entregas_total: number; ultima_entrega: string | null;
    entregas_verificadas: number;
    vendas_7d: number;
    destinos: number;
    disparos_7d: number; disparos_ok: number; disparos_falha: number;
    ultimo_erro: string | null;
  }>(sql`
    SELECT
      (SELECT count(*)::int FROM events WHERE tenant_id = ${tenantId}
         AND occurred_at > now() - interval '24 hours')                       AS eventos_24h,
      (SELECT count(*)::int FROM events WHERE tenant_id = ${tenantId})        AS eventos_total,
      (SELECT to_char(max(occurred_at), 'DD/MM HH24:MI') FROM events
         WHERE tenant_id = ${tenantId})                                       AS ultimo_evento,
      (SELECT count(*)::int FROM click_sessions WHERE tenant_id = ${tenantId}
         AND first_seen_at > now() - interval '24 hours')                     AS sessoes_24h,

      (SELECT count(*)::int FROM webhook_deliveries WHERE tenant_id = ${tenantId}
         AND received_at > now() - interval '7 days')                         AS entregas_7d,
      (SELECT count(*)::int FROM webhook_deliveries WHERE tenant_id = ${tenantId}) AS entregas_total,
      (SELECT to_char(max(received_at), 'DD/MM HH24:MI') FROM webhook_deliveries
         WHERE tenant_id = ${tenantId})                                       AS ultima_entrega,
      (SELECT count(*)::int FROM webhook_deliveries WHERE tenant_id = ${tenantId}
         AND verified AND received_at > now() - interval '7 days')            AS entregas_verificadas,

      (SELECT count(*)::int FROM orders WHERE tenant_id = ${tenantId}
         AND status = 'paid' AND occurred_at > now() - interval '7 days')     AS vendas_7d,

      (SELECT count(*)::int FROM destinations WHERE tenant_id = ${tenantId} AND active) AS destinos,

      (SELECT count(*)::int FROM dispatches WHERE tenant_id = ${tenantId}
         AND created_at > now() - interval '7 days')                          AS disparos_7d,
      (SELECT count(*)::int FROM dispatches WHERE tenant_id = ${tenantId}
         AND status = 'sent' AND created_at > now() - interval '7 days')      AS disparos_ok,
      (SELECT count(*)::int FROM dispatches WHERE tenant_id = ${tenantId}
         AND status = 'failed' AND created_at > now() - interval '7 days')    AS disparos_falha,
      (SELECT error FROM dispatches WHERE tenant_id = ${tenantId}
         AND status = 'failed' ORDER BY created_at DESC LIMIT 1)              AS ultimo_erro
  `));

  const n = (v: unknown) => Number(v ?? 0);

  /* --------------------------------------------- 1. o script no site -- */
  const script: Verificacao = (() => {
    if (n(c?.eventos_total) === 0) {
      return {
        etapa: "1 · Script no site",
        pergunta: "O site está mandando eventos?",
        estado: "nunca" as Estado,
        detalhe: "nenhum evento chegou até hoje",
        conserto: "Cole o trecho de Integrações antes do </head> em todas as páginas. Depois abra o site uma vez e volte aqui.",
      };
    }
    if (n(c?.eventos_24h) === 0) {
      return {
        etapa: "1 · Script no site",
        pergunta: "O site está mandando eventos?",
        estado: "parado" as Estado,
        detalhe: `parou — último evento em ${c?.ultimo_evento}`,
        conserto: "O script já funcionou e parou. Confira se ele continua na página e se o site recebeu visita nas últimas 24 horas.",
      };
    }
    return {
      etapa: "1 · Script no site",
      pergunta: "O site está mandando eventos?",
      estado: "ok" as Estado,
      detalhe: `${n(c?.eventos_24h)} eventos e ${n(c?.sessoes_24h)} sessões nas últimas 24h`,
    };
  })();

  /* ------------------------------------------ 2. o webhook do gateway -- */
  const webhook: Verificacao = (() => {
    if (n(c?.entregas_total) === 0) {
      return {
        etapa: "2 · Webhook do gateway",
        pergunta: "As vendas estão chegando?",
        estado: "nunca" as Estado,
        detalhe: "nenhuma notificação de venda até hoje",
        conserto: "Cole a URL de webhook, que está em Integrações, no painel do seu gateway. Depois faça uma venda de teste.",
      };
    }
    return {
      etapa: "2 · Webhook do gateway",
      pergunta: "As vendas estão chegando?",
      estado: n(c?.entregas_7d) === 0 ? ("parado" as Estado) : ("ok" as Estado),
      detalhe: n(c?.entregas_7d) === 0
        ? `nada em 7 dias — última em ${c?.ultima_entrega}`
        : `${n(c?.entregas_7d)} notificações e ${n(c?.vendas_7d)} vendas pagas em 7 dias`,
      conserto: n(c?.entregas_7d) === 0
        ? "Pode ser só ausência de venda no período. Se houve venda e ela não apareceu, confira a URL no painel do gateway."
        : undefined,
    };
  })();

  /* -------------------------------------------------- 3. o pixel ------ */
  const pixel: Verificacao = n(c?.destinos) === 0
    ? {
        etapa: "3 · Destino configurado",
        pergunta: "Existe para onde enviar?",
        estado: "nunca",
        detalhe: "nenhum pixel cadastrado",
        conserto: "Em Integrações → Pixel, cadastre o pixel da Meta com o token da API de Conversões.",
      }
    : {
        etapa: "3 · Destino configurado",
        pergunta: "Existe para onde enviar?",
        estado: "ok",
        detalhe: `${n(c?.destinos)} destino(s) ativo(s)`,
      };

  /* ------------------------------------------------ 4. o disparo ------ */
  const disparo: Verificacao = (() => {
    if (n(c?.destinos) === 0) {
      return {
        etapa: "4 · Envio para a plataforma",
        pergunta: "As conversões estão saindo?",
        estado: "nunca" as Estado,
        detalhe: "sem destino, não há o que enviar",
      };
    }
    if (n(c?.disparos_7d) === 0) {
      return {
        etapa: "4 · Envio para a plataforma",
        pergunta: "As conversões estão saindo?",
        estado: "nunca" as Estado,
        detalhe: "nenhum disparo em 7 dias",
        conserto: "Só sai disparo quando há evento ou venda. Resolva os passos acima primeiro.",
      };
    }
    if (n(c?.disparos_falha) > 0 && n(c?.disparos_ok) === 0) {
      return {
        etapa: "4 · Envio para a plataforma",
        pergunta: "As conversões estão saindo?",
        estado: "parado" as Estado,
        detalhe: `${n(c?.disparos_falha)} falharam, nenhum entregue`,
        conserto: c?.ultimo_erro
          ? `Último erro: ${c.ultimo_erro}`
          : "Confira o token do pixel em Integrações.",
      };
    }
    if (n(c?.disparos_falha) > 0) {
      return {
        etapa: "4 · Envio para a plataforma",
        pergunta: "As conversões estão saindo?",
        estado: "atencao" as Estado,
        detalhe: `${n(c?.disparos_ok)} entregues, ${n(c?.disparos_falha)} falharam`,
        conserto: c?.ultimo_erro ? `Último erro: ${c.ultimo_erro}` : undefined,
      };
    }
    return {
      etapa: "4 · Envio para a plataforma",
      pergunta: "As conversões estão saindo?",
      estado: "ok" as Estado,
      detalhe: `${n(c?.disparos_ok)} entregues em 7 dias, nenhuma falha`,
    };
  })();

  return [script, webhook, pixel, disparo];
}

/* --------------------------------------------------------- ao vivo -- */

export interface EventoRecebido {
  quando: string;
  nome: string;
  clickId: string | null;
  origem: string;
  campanha: string | null;
  pagina: string | null;
  valorCents: number | null;
}

/**
 * Os últimos eventos que chegaram do navegador.
 * É o que se olha logo depois de colar o script, para ver a coisa acontecendo.
 */
export async function eventosRecentes(tenantId: string, limite = 25): Promise<EventoRecebido[]> {
  const linhas = await linhasDe(db.execute<{
    quando: string; nome: string; click_id: string | null;
    origem: string; campanha: string | null; pagina: string | null; valor: number | null;
  }>(sql`
    SELECT
      to_char(e.occurred_at, 'DD/MM HH24:MI:SS') AS quando,
      e.name AS nome,
      e.click_id,
      coalesce(nullif(cs.utm_source, ''), '(direto)') AS origem,
      coalesce(cs.campaign_name, cs.campaign_id) AS campanha,
      e.page_url AS pagina,
      e.value_cents AS valor
    FROM events e
    LEFT JOIN click_sessions cs ON cs.click_id = e.click_id
    WHERE e.tenant_id = ${tenantId}
    ORDER BY e.occurred_at DESC
    LIMIT ${limite}
  `));

  return linhas.map((l) => ({
    quando: l.quando,
    nome: l.nome,
    clickId: l.click_id ? l.click_id.slice(0, 8) : null,
    origem: l.origem,
    campanha: l.campanha,
    pagina: l.pagina,
    valorCents: l.valor === null ? null : Number(l.valor),
  }));
}

export interface EntregaRecebida {
  quando: string;
  gateway: string;
  eventoId: string;
  verificada: boolean;
  processada: boolean;
  erro: string | null;
}

/** As últimas notificações de venda que os gateways mandaram. */
export async function entregasRecentes(tenantId: string, limite = 15): Promise<EntregaRecebida[]> {
  const linhas = await linhasDe(db.execute<{
    quando: string; gateway: string; evento: string;
    verificada: boolean; processada: boolean; erro: string | null;
  }>(sql`
    SELECT
      to_char(w.received_at, 'DD/MM HH24:MI:SS') AS quando,
      gc.gateway,
      w.gateway_event_id AS evento,
      w.verified AS verificada,
      (w.processed_at IS NOT NULL) AS processada,
      w.error AS erro
    FROM webhook_deliveries w
    JOIN gateway_connections gc ON gc.id = w.gateway_connection_id
    WHERE w.tenant_id = ${tenantId}
    ORDER BY w.received_at DESC
    LIMIT ${limite}
  `));

  return linhas.map((l) => ({
    quando: l.quando,
    gateway: l.gateway,
    eventoId: l.evento,
    verificada: !!l.verificada,
    processada: !!l.processada,
    erro: l.erro,
  }));
}
