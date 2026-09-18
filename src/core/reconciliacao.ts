/*
 * Vendas que aconteceram e nunca chegaram aqui.
 *
 * A fila de reenvio resolve o disparo que falhou. Este módulo resolve o buraco
 * anterior, e pior: a venda que o sistema nunca soube que existiu. Não há o que
 * reenviar, porque nunca houve tentativa — e no painel a campanha aparece
 * gastando sem vender, o que leva a desligar anúncio que estava lucrando.
 *
 * Duas causas, duas varreduras:
 *
 * 1. O WEBHOOK CHEGOU E O PROCESSAMENTO MORREU. Deploy no meio, tempo esgotado
 *    da função, banco fora. A entrega ficou gravada com `processed_at` nulo, e
 *    o corpo cru está guardado — dá para reprocessar sem falar com ninguém.
 *    O gateway costuma reentregar, mas nem todos reentregam, e nenhum reentrega
 *    para sempre.
 *
 * 2. O WEBHOOK NUNCA CHEGOU. Aí não há corpo nenhum, e é preciso perguntar ao
 *    gateway. Só que perguntar exige saber POR QUAL PEDIDO perguntar, e é
 *    justamente o que não se tem numa venda que nunca apareceu.
 *
 *    A saída é a reivindicação: quando a loja cria o pedido, ela já avisa este
 *    servidor do par (clickId, id do pedido). Reivindicação sem venda
 *    correspondente depois de um tempo é exatamente a lista de candidatos —
 *    ground truth que já está no banco.
 *
 * Por que NÃO existe uma varredura por listagem: seria o caminho completo,
 * pegando inclusive gateway sem reivindicação, mas depende de um endpoint de
 * listagem cuja forma eu não verifiquei em documentação (a do pagou.ai está
 * fora do ar). Chutar rota e parâmetro contra API de pagamento é como se ganha
 * bloqueio por requisição malformada em série. Quando houver doc na mão, entra
 * como terceira varredura e o resto deste módulo não muda.
 *
 * A varredura é IDEMPOTENTE por construção: `registrarPedido` só deixa o estado
 * avançar, então venda que já entrou pelo webhook para ali, sem disparo novo.
 */

import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db/index";
import { gatewayConnections, orderClaims, orders, webhookDeliveries } from "../db/schema";
import { getGateway } from "../gateways/registry";
import { registrarPedido } from "./pedido";
import { decryptRecord } from "./crypto";
import type { CanonicalOrder } from "./types";

/*
 * Uma entrega só é considerada travada depois disto. Sem a folga, a varredura
 * disputaria com a requisição que ainda está processando a mesma venda.
 */
const MIN_TRAVADA = 5 * 60_000;

/*
 * Folga antes de cobrar o webhook de uma reivindicação. Gateway atrasa alguns
 * minutos em dia de pico, e cobrar antes disso é gastar chamada à toa.
 */
const MIN_ORFA = 15 * 60_000;

/*
 * Teto de perguntas por reivindicação, e o intervalo entre elas.
 *
 * A maioria das reivindicações órfãs não é venda perdida: é carrinho que a
 * pessoa abandonou. Sem teto, cada abandono viraria uma consulta por hora para
 * sempre, e uma loja com mil abandonos por dia bateria na API do gateway o
 * tempo todo sem nunca achar nada — que é como se toma bloqueio sem fazer nada
 * de errado de propósito.
 */
const MAX_CONSULTAS = 5;
const ESPERA_CONSULTA = 60 * 60_000;

/* Passado isto, a conversão não seria mais aceita pelas plataformas mesmo. */
const JANELA_DIAS = 7;

export interface ResumoReconciliacao {
  entregasReprocessadas: number;
  entregasFalhadas: number;
  reivindicacoesConsultadas: number;
  vendasRecuperadas: number;
}

export async function reconciliar(
  tenantId: string,
  limite = 10,
): Promise<ResumoReconciliacao> {
  const r: ResumoReconciliacao = {
    entregasReprocessadas: 0,
    entregasFalhadas: 0,
    reivindicacoesConsultadas: 0,
    vendasRecuperadas: 0,
  };

  await reprocessarEntregas(tenantId, limite, r);
  await cobrarReivindicacoes(tenantId, limite, r);

  return r;
}

/* ---------------------------------------------------- 1. entrega travada -- */

async function reprocessarEntregas(
  tenantId: string,
  limite: number,
  r: ResumoReconciliacao,
): Promise<void> {
  const travadas = await db
    .select({
      id: webhookDeliveries.id,
      rawBody: webhookDeliveries.rawBody,
      headers: webhookDeliveries.headers,
      verified: webhookDeliveries.verified,
      conexaoId: webhookDeliveries.gatewayConnectionId,
    })
    .from(webhookDeliveries)
    .where(and(
      eq(webhookDeliveries.tenantId, tenantId),
      isNull(webhookDeliveries.processedAt),
      lt(webhookDeliveries.receivedAt, new Date(Date.now() - MIN_TRAVADA)),
      /* Fora da janela das plataformas, reprocessar não recupera conversão. */
      sql`${webhookDeliveries.receivedAt} > now() - interval '${sql.raw(String(JANELA_DIAS))} days'`,
    ))
    .limit(limite);

  for (const entrega of travadas) {
    const [conexao] = await db
      .select()
      .from(gatewayConnections)
      .where(eq(gatewayConnections.id, entrega.conexaoId))
      .limit(1);

    if (!conexao) continue;

    const adapter = getGateway(conexao.gateway);
    if (!adapter) continue;

    try {
      const req = {
        headers: entrega.headers ?? {},
        rawBody: entrega.rawBody,
        query: {},
      };

      let pedido = await adapter.parse(req);

      /* Evento que não é venda: marca como tratado para sair da varredura. */
      if (!pedido) {
        await db.update(webhookDeliveries)
          .set({ processedAt: new Date(), error: null })
          .where(eq(webhookDeliveries.id, entrega.id));
        r.entregasReprocessadas++;
        continue;
      }

      /*
       * Refaz o enriquecimento. A confirmação de valor NÃO é refeita: ela já
       * aconteceu antes de a entrega ser gravada, e o resultado está em
       * `verified`. Repetir aqui gastaria chamada para chegar à mesma conclusão.
       */
      if (adapter.enrich && Object.keys(conexao.credentials).length > 0 && !pedido.customer) {
        try {
          const cred = await decryptRecord(conexao.credentials);
          pedido = await adapter.enrich(pedido, cred);
        } catch { /* segue com o que o webhook trouxe */ }
      }

      const res = await registrarPedido(
        { tenantId, conexaoId: conexao.id, gateway: conexao.gateway },
        pedido,
      );

      await db.update(webhookDeliveries)
        .set({ processedAt: new Date(), error: null })
        .where(eq(webhookDeliveries.id, entrega.id));

      r.entregasReprocessadas++;
      if (!res.ignorado && res.status === "paid") r.vendasRecuperadas++;
    } catch (e) {
      /*
       * Continua sem `processed_at`, para a próxima varredura tentar de novo —
       * mas o erro fica registrado, que é o que permite ver no painel uma venda
       * que está falhando sempre pelo mesmo motivo.
       */
      await db.update(webhookDeliveries)
        .set({ error: e instanceof Error ? e.message : String(e) })
        .where(eq(webhookDeliveries.id, entrega.id));
      r.entregasFalhadas++;
    }
  }
}

/* ------------------------------------------------ 2. reivindicação órfã -- */

async function cobrarReivindicacoes(
  tenantId: string,
  limite: number,
  r: ResumoReconciliacao,
): Promise<void> {
  const agora = Date.now();

  /*
   * Reivindicação sem venda: a loja avisou que criou o pedido e o webhook
   * correspondente nunca virou linha em `orders`.
   */
  const orfas = await db
    .select({
      id: orderClaims.id,
      gateway: orderClaims.gateway,
      gatewayOrderId: orderClaims.gatewayOrderId,
      consultas: orderClaims.checks,
    })
    .from(orderClaims)
    .where(and(
      eq(orderClaims.tenantId, tenantId),
      /*
       * "Sem venda" é por (loja, GATEWAY, pedido) — e não só por (loja, pedido).
       *
       * O id do pedido é escolha de cada gateway, e nada garante que dois não
       * repitam o mesmo: a Appmax numera de 1 em diante. Casando só pelo id, a
       * venda 1041 de um gateway fazia a reivindicação 1041 de OUTRO parecer
       * resolvida, e a varredura nunca ia atrás dela. Sem erro em lugar nenhum
       * — só uma venda real que fica órfã para sempre, que é exatamente o
       * desfecho que este módulo existe para evitar.
       *
       * `NOT EXISTS` no lugar do `leftJoin` de antes porque a marca do gateway
       * não está em `orders`: ela vive na conexão, e comparar por ela exige a
       * junção com `gateway_connections`.
       */
      sql`NOT EXISTS (
        SELECT 1 FROM ${orders} o
        JOIN ${gatewayConnections} gc ON gc.id = o.gateway_connection_id
        WHERE o.tenant_id = ${orderClaims.tenantId}
          AND o.gateway_order_id = ${orderClaims.gatewayOrderId}
          AND gc.gateway = ${orderClaims.gateway}
      )`,
      lt(orderClaims.createdAt, new Date(agora - MIN_ORFA)),
      sql`${orderClaims.createdAt} > now() - interval '${sql.raw(String(JANELA_DIAS))} days'`,
      lt(orderClaims.checks, MAX_CONSULTAS),
      or(
        isNull(orderClaims.checkedAt),
        lt(orderClaims.checkedAt, new Date(agora - ESPERA_CONSULTA)),
      ),
    ))
    .limit(limite);

  for (const orfa of orfas) {
    const adapter = getGateway(orfa.gateway);
    if (!adapter?.fetchOrder) continue;

    /*
     * TODAS as conexoes deste gateway, e nao a primeira.
     *
     * Com duas lojas do mesmo gateway, escolher uma no `.limit(1)` era
     * perguntar pelo pedido de uma usando a credencial da outra. A resposta e
     * "nao existe" — e este arquivo trata "nao existe" como carrinho que nunca
     * virou pedido, zerando as tentativas. A venda real ficava orfa para
     * sempre, e o motivo nao aparecia em lugar nenhum.
     *
     * A reivindicacao guarda o gateway, nao a conexao: quem chama /api/claim e
     * a loja, que sabe o gateway e nao tem por que saber de conexao. Entao a
     * pergunta certa nao e "qual conexao" e sim "alguma destas conhece este
     * pedido" — e so quando NENHUMA conhece e que ele nao existe.
     */
    const conexoes = (await db
      .select()
      .from(gatewayConnections)
      .where(and(
        eq(gatewayConnections.tenantId, tenantId),
        eq(gatewayConnections.gateway, orfa.gateway),
        eq(gatewayConnections.active, true),
      ))).filter((c) => Object.keys(c.credentials).length > 0);

    if (!conexoes.length) continue;

    /*
     * Marca a consulta ANTES de fazê-la. Se a função morrer no meio, o contador
     * já subiu — o contrário deixaria a reivindicação sendo consultada para
     * sempre, que é justamente o que este contador existe para impedir.
     */
    await db.update(orderClaims)
      .set({ checkedAt: new Date(), checks: orfa.consultas + 1 })
      .where(eq(orderClaims.id, orfa.id));

    r.reivindicacoesConsultadas++;

    let pedido: CanonicalOrder | null = null;
    let conexao: (typeof conexoes)[number] | undefined;
    let instavel = false;

    for (const c of conexoes) {
      try {
        const cred = await decryptRecord(c.credentials);
        const achado = await adapter.fetchOrder(orfa.gatewayOrderId, cred);
        if (achado) { pedido = achado; conexao = c; break; }
      } catch {
        /* API instavel. Nao conclui nada por esta conexao. */
        instavel = true;
      }
    }

    /*
     * Se alguma conexao falhou por instabilidade, "nao achei" nao significa
     * "nao existe": pode estar justamente na que nao respondeu. Sai sem
     * concluir, e a proxima varredura tenta de novo dentro do teto.
     */
    if (!pedido && instavel) continue;

    /*
     * Pedido que não existe no gateway não é venda perdida — é reivindicação de
     * carrinho que nunca virou pedido. Zera as tentativas restantes para não
     * consultar de novo.
     */
    /* `conexao` so fica vazia quando `pedido` tambem esta — andam juntos. */
    if (!pedido || !conexao) {
      await db.update(orderClaims)
        .set({ checks: MAX_CONSULTAS })
        .where(eq(orderClaims.id, orfa.id));
      continue;
    }

    const res = await registrarPedido(
      { tenantId, conexaoId: conexao.id, gateway: orfa.gateway },
      pedido,
    );

    if (!res.ignorado && res.status === "paid") r.vendasRecuperadas++;

    /*
     * Venda registrada em estado final para de ser consultada. Pendente
     * continua na roda: ela ainda pode ser paga, e é essa transição que
     * interessa recuperar.
     */
    if (res.status === "paid" || res.status === "refunded" || res.status === "chargeback") {
      await db.update(orderClaims)
        .set({ checks: MAX_CONSULTAS })
        .where(eq(orderClaims.id, orfa.id));
    }
  }
}
