/*
 * Receber uma venda de fora: o caminho, do payload cru até a conversão enviada.
 *
 * Vive fora de app/ porque tem DUAS portas — o webhook do gateway
 * (/api/webhook/<gateway>/<segredo>) e a entrada por API
 * (/api/pedidos/<segredo>) — e as duas precisam se comportar igual. Rota do
 * Next não pode importar handler de outra rota (o build embrulha os módulos de
 * rota, e o resultado é um 405 em vez de um erro claro), então o caminho comum
 * mora aqui e as rotas ficam finas.
 *
 * O segredo no caminho não é enfeite: é a única barreira contra venda forjada
 * em gateway que não assina o payload. Quem tiver o endereço consegue inserir
 * uma venda — e, pior, disparar uma conversão falsa que a Meta vai usar para
 * otimizar. Por isso ele é longo, aleatório e por conexão, nunca global.
 */

import { after } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index";
import { gatewayConnections, webhookDeliveries } from "../db/schema";
import { getGateway } from "../gateways/registry";
import { ipDoCliente } from "./ip";
import { TETOS, cabeNoLimite, contar, estourou, respostaDeEstouro } from "./contencao";
import { reenviarPendentes } from "./dispatch";
import { reconciliar } from "./reconciliacao";
import { registrarPedido } from "./pedido";
import type { CanonicalOrder } from "./types";
import { decryptRecord } from "./crypto";


/*
 * Vale a pena consultar o gateway para completar este comprador?
 *
 * Não é "existe comprador": é "existe o que importa". As chaves que decidem a
 * qualidade do evento são justamente as que gateway nenhum manda no webhook —
 * documento, CEP, cidade e estado. Um comprador com nome e e-mail parece
 * preenchido e vale metade.
 *
 * O telefone entra na lista porque a pagou.ai manda a palavra "null" nele; o
 * número de verdade está no cadastro.
 */
function faltaComprador(c: CanonicalOrder["customer"]): boolean {
  if (!c) return true;
  return !c.document || !c.zip || !c.city || !c.state || !c.phone;
}

export async function receberVenda(
  req: Request,
  gateway: string,
  secret: string,
): Promise<Response> {

  const adapter = getGateway(gateway);
  if (!adapter) return Response.json({ erro: "gateway desconhecido" }, { status: 404 });

  /*
   * Teto de corpo, antes de ler.
   *
   * `webhook_deliveries.raw_body` guarda o corpo inteiro e não tem retenção —
   * então um POST de 50 MB não é um pico, é 50 MB no banco para sempre.
   * Nenhum webhook de verdade chega perto: o maior deles, com dezenas de
   * itens, fica em alguns kilobytes.
   */
  if (!cabeNoLimite(req.headers.get("content-length"))) {
    return Response.json({ erro: "corpo grande demais" }, { status: 413 });
  }

  /*
   * A contenção, e o cuidado que ela exige AQUI.
   *
   * Barrar coleta perde atribuição; barrar webhook perde VENDA. Por isso:
   *
   *   o teto é alto — gateway manda em rajada quando reentrega fila acumulada,
   *   e isso é comportamento legítimo, não ataque;
   *
   *   a resposta é 429, que gateway trata como transitório e reentrega. Um 4xx
   *   permanente faria ele DESISTIR, e a venda sumiria sem erro nenhum do lado
   *   de cá;
   *
   *   e falha ABERTO: se a contagem não puder ser feita, a venda entra. Perder
   *   venda por causa da defesa contra abuso é trocar um problema grande por
   *   um problema pior.
   */
  const agoraMs = Date.now();
  const ip = ipDoCliente(req);
  try {
    const [porConexao, porIp] = await db.batch([
      contar({ ...TETOS.webhookPorConexao, quem: secret.slice(0, 80) }, agoraMs),
      contar({ ...TETOS.webhookPorIp, quem: ip ?? "sem-ip" }, agoraMs),
    ]);
    if (estourou(porConexao[0]?.contagem, TETOS.webhookPorConexao.teto)
      || estourou(porIp[0]?.contagem, TETOS.webhookPorIp.teto)) {
      return respostaDeEstouro(agoraMs, TETOS.webhookPorConexao.segundos);
    }
  } catch (e) {
    console.error("[receber] contenção indisponível, seguindo sem ela:",
      e instanceof Error ? e.message : String(e));
  }

  const [conexao] = await db
    .select()
    .from(gatewayConnections)
    .where(and(
      eq(gatewayConnections.gateway, gateway),
      eq(gatewayConnections.webhookSecret, secret),
      eq(gatewayConnections.active, true),
    ))
    .limit(1);

  /* Segredo errado e conexão inexistente devolvem a mesma coisa, de propósito:
     um 404 que diferenciasse os dois casos viraria um oráculo de segredos. */
  if (!conexao) return Response.json({ erro: "não encontrado" }, { status: 404 });

  const rawBody = await req.text();
  /*
   * E de novo com o tamanho real, para o caso de não vir `content-length`
   * (`Transfer-Encoding: chunked` não manda). Aqui já é tarde para economizar
   * memória, mas ainda dá para não GRAVAR o corpo gigante — que é o estrago
   * que fica.
   */
  if (!cabeNoLimite(null, rawBody.length)) {
    return Response.json({ erro: "corpo grande demais" }, { status: 413 });
  }
  const cabecalhos: Record<string, string> = {};
  req.headers.forEach((v, k) => { cabecalhos[k] = v; });

  /*
   * As credenciais sao decifradas antes da verificacao porque alguns gateways
   * assinam o webhook com um segredo PROPRIO, guardado aqui — a MillionsPay e
   * o caso. O segredo do caminho da URL diz quem pode bater na porta; o do
   * gateway prova que quem bateu foi ele. Sao coisas diferentes, e confundi-las
   * rejeita todo webhook verdadeiro com 401.
   */
  let credenciais: Record<string, string> | undefined;
  if (Object.keys(conexao.credentials).length > 0) {
    try {
      credenciais = await decryptRecord(conexao.credentials);
    } catch (e) {
      /*
       * CREDENCIAL ILEGÍVEL PARA A VERIFICAÇÃO DE ASSINATURA.
       *
       * Aqui havia um `catch` vazio que seguia adiante, e o efeito era o pior
       * possível: sem credencial, `verify` devolve `sem_assinatura` — o mesmo
       * sinal que um gateway que genuinamente não assina — e a linha abaixo
       * trata isso como "não há como provar a origem" e ACEITA com 200. Ou
       * seja: chave de cifragem incompatível DESLIGAVA a verificação de
       * assinatura, em silêncio, para todos os gateways de uma vez.
       *
       * Não é hipotético. Acontece sempre que a CREDENTIALS_KEY do ambiente
       * deixa de ser a que cifrou as linhas — troca de chave, restauração de
       * backup, ambiente novo mal configurado. E o sintoma seria uma coluna
       * `verified` virando false aos poucos, que ninguém olha.
       *
       * 500, e não 401, e a escolha é deliberada:
       *
       *   401 diria "sua assinatura está errada", o que é MENTIRA — quem
       *   assinou fez certo. E a maioria dos gateways não repete um 401: a
       *   venda seria perdida por um defeito que é nosso.
       *
       *   500 diz "o erro é meu". Gateway repete 5xx, então a venda fica na
       *   fila de reentrega em vez de sumir, e há tempo de corrigir a chave
       *   sem perder nada. E 5xx aparece no log da Vercel e no painel do
       *   gateway — que é onde alguém precisa ver.
       */
      const motivo = e instanceof Error ? e.message : String(e);
      console.error(
        `[receber] credencial ilegível na conexão ${conexao.id} (${gateway}): ${motivo}.`
        + " A CREDENTIALS_KEY deste ambiente não abre o que está gravado."
        + " Diagnóstico: npm run conferir:credenciais",
      );
      return Response.json({
        erro: "credencial do gateway ilegível neste ambiente",
        detalhe: "não é a sua assinatura — é configuração nossa. Reenvie.",
      }, { status: 500 });
    }
  }

  const verificacao = await adapter.verify(
    { headers: cabecalhos, rawBody, query: {} }, secret, credenciais,
  );

  /*
   * `sem_assinatura` não é falha: é a constatação de que o gateway não oferece
   * como provar a origem. O segredo do caminho já foi conferido, e a venda
   * entra marcada como não verificada — o que permite ao painel separar o que
   * está provado do que está apenas plausível.
   *
   * Qualquer outro motivo é assinatura inválida de verdade, e aí é rejeição.
   */
  const semAssinatura = !verificacao.ok && verificacao.reason === "sem_assinatura";
  if (!verificacao.ok && !semAssinatura) {
    return Response.json({ erro: "assinatura inválida" }, { status: 401 });
  }

  let pedido;
  try {
    pedido = await adapter.parse({ headers: cabecalhos, rawBody, query: {} });
  } catch (e) {
    return Response.json(
      { erro: "payload ilegível", detalhe: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }

  /* Evento que não representa estado de venda — teste de conexão, payout. */
  if (!pedido) return Response.json({ ok: true, ignorado: true });

  const temCredencial = Object.keys(conexao.credentials).length > 0;
  let confirmado = verificacao.ok;

  /*
   * Confirmação pela API, para gateway que não assina o webhook.
   *
   * Sem assinatura, a mensagem sozinha não prova nada: quem descobrir a URL
   * injeta uma venda que nunca houve. E o estrago não é o painel mentir — é a
   * conversão falsa chegar na Meta e ela passar a otimizar para um comprador
   * que não existe.
   *
   * A distinção que rege o que fazer: CONTRADIÇÃO é fraude, ERRO é
   * desconhecido. Se a API diz que o pedido não existe, ou diz outro valor,
   * recusamos. Se a API está fora do ar, seguimos sem confirmar — derrubar
   * venda de verdade por causa de instabilidade alheia seria pior que o risco
   * que se está evitando.
   */
  if (semAssinatura && temCredencial && adapter.fetchOrder) {
    let cred: Record<string, string> | null = null;
    try {
      cred = await decryptRecord(conexao.credentials);
    } catch { /* credencial ilegível: segue sem confirmar */ }

    if (cred) {
      try {
        const daApi = await adapter.fetchOrder(pedido.gatewayOrderId, cred);

        if (!daApi) {
          return Response.json(
            { erro: "pedido não existe no gateway" },
            { status: 403 },
          );
        }

        if (daApi.grossCents !== pedido.grossCents) {
          return Response.json({
            erro: "valor do webhook não confere com o gateway",
            recebido: pedido.grossCents,
            real: daApi.grossCents,
          }, { status: 403 });
        }

        /*
         * O estado da API é mais atual que o do webhook, que pode ter ficado
         * na fila. Uma venda já estornada não deve entrar como paga só porque
         * a notificação de pagamento chegou atrasada.
         */
        pedido = { ...pedido, status: daApi.status, customer: pedido.customer ?? daApi.customer };
        confirmado = true;
      } catch {
        /* API instável: segue como não confirmado, sem recusar. */
      }
    }
  }

  /*
   * Completa o que o webhook não trouxe. A Appmax não manda comprador nenhum
   * no webhook de pedido, então sem isto a venda dela chegaria só com as
   * chaves de navegador. Melhor-esforço: falhar aqui não derruba a venda.
   *
   * A CONDIÇÃO ERA `!pedido.customer`, e isso desligava o enriquecimento
   * inteiro para quem manda comprador PARCIAL.
   *
   * Foi escrita pensando na Appmax, que não manda nada. A pagou.ai manda nome,
   * e-mail e telefone — comprador existe, então a busca nunca rodava, e o
   * endereço e o CPF que ela guarda em `/v2/customers` ficavam lá. Numa venda
   * real o Purchase saiu com quatro chaves de correspondência quando podia ter
   * saído com oito, e nada acusou: a venda entrou, o disparo saiu, e só a
   * qualidade do evento ficou pela metade.
   */
  if (adapter.enrich && temCredencial && faltaComprador(pedido.customer)) {
    try {
      pedido = await adapter.enrich(pedido, credenciais ?? await decryptRecord(conexao.credentials));
    } catch { /* segue com o que o webhook trouxe */ }
  }

  /*
   * Registra a entrega antes de processar. O índice único em
   * (conexão, gatewayEventId) faz a reentrega colidir aqui e sair sem efeito —
   * é o que garante que um webhook repetido não vire venda repetida.
   */
  const entrega = await db.insert(webhookDeliveries).values({
    tenantId: conexao.tenantId,
    gatewayConnectionId: conexao.id,
    gatewayEventId: pedido.gatewayEventId,
    verified: confirmado,
    rawBody,
    headers: cabecalhos,
  }).onConflictDoNothing().returning({ id: webhookDeliveries.id });

  if (!entrega[0]) return Response.json({ ok: true, duplicado: true });

  try {
    const res = await registrarPedido(
      { tenantId: conexao.tenantId, conexaoId: conexao.id, gateway },
      pedido,
    );

    await db.update(webhookDeliveries)
      .set({ processedAt: new Date() })
      .where(eq(webhookDeliveries.id, entrega[0].id));

    if (res.ignorado) {
      return Response.json({ ok: true, estado_ignorado: res.status });
    }

    /*
     * Reenvio e reconciliacao pegam carona aqui, depois da resposta.
     *
     * Nao ha cron: o plano Hobby da Vercel limita a uma execucao por dia, o que
     * e inutil para recuperar conversao. Mas chegou webhook quer dizer que ha
     * venda acontecendo, e e exatamente quando vale gastar alguns segundos
     * atras do que ficou para tras. Loja parada nao paga nada por isso.
     */
    after(async () => {
      try {
        await reenviarPendentes(conexao.tenantId, 10);
        await reconciliar(conexao.tenantId, 10);
      } catch { /* melhor-esforco; a venda desta requisicao ja entrou */ }
    });

    return Response.json({
      ok: true,
      pedido: pedido.gatewayOrderId,
      status: res.status,
      atribuicao: res.atribuicao.method,
      verificado: confirmado,
      disparos: res.disparos,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.update(webhookDeliveries)
      .set({ error: msg })
      .where(eq(webhookDeliveries.id, entrega[0].id));

    /*
     * 500 é deliberado: o gateway reentrega, e a entrega ficou registrada com o
     * erro. Devolver 200 aqui perderia a venda em silêncio, que é o pior
     * desfecho possível.
     */
    return Response.json({ erro: "falha ao processar", detalhe: msg }, { status: 500 });
  }
}
