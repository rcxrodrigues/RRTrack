/*
 * O contrato que todo gateway precisa cumprir.
 *
 * Adicionar um gateway novo — Kiwify, Hotmart, Braip, Shopify, Appmax — é
 * escrever um arquivo que implementa esta interface e registrá-lo. Nada fora
 * de src/gateways/ precisa mudar.
 */

import type { CanonicalOrder } from "../core/types";

export interface WebhookRequest {
  headers: Record<string, string>;
  /** Corpo cru. Verificação de assinatura precisa dos bytes originais. */
  rawBody: string;
  query: Record<string, string>;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string };

export interface GatewayAdapter {
  /** Identificador estável, usado na URL do webhook e no banco. */
  id: string;
  label: string;

  /*
   * Plataforma de venda ou gateway de pagamento.
   *
   * A distinção não é decorativa: enquanto tudo aqui dentro se chamava
   * "gateway", a tela agrupava a Shopify sob "Gateways de pagamento" — e quem
   * procurava onde ligar a loja não achava, porque a Shopify não é um gateway
   * e a tela estava dizendo que era. O lojista concluiu, corretamente, que
   * não havia lugar para ela.
   *
   * Uma plataforma é dona da venda inteira: catálogo, carrinho, checkout e
   * endereço do comprador. Um gateway só processa o pagamento, e por isso
   * quase nunca sabe o endereço — que é a razão de a Shopify render mais
   * chaves de correspondência que qualquer um dos outros.
   *
   * `api` é a terceira, e não é preguiça de escolher entre as duas: é o
   * servidor do próprio lojista empurrando a venda, sem plataforma nem
   * gateway do outro lado. Enfiá-la numa das outras duas repetiria o mesmo
   * erro de categoria, só que com outro nome.
   */
  especie: "plataforma" | "gateway" | "api";

  /*
   * Como este gateway devolve o que mandamos no checkout. Determina onde o
   * `clickId` viaja. `src` e `sck` são a convenção dos gateways brasileiros;
   * gateways internacionais costumam ter `metadata` ou `note_attributes`.
   */
  passthroughFields: readonly string[];

  /*
   * Verifica que o webhook veio mesmo do gateway.
   *
   * Gateways sem assinatura HMAC documentada (é o caso do pagou.ai) devolvem
   * `ok: false` com motivo "sem_assinatura" — o roteador então exige o segredo
   * no path e confirma o valor contra a API antes de contabilizar. Um webhook
   * não verificado nunca dispara conversão para plataforma de anúncio.
   */
  verify(
    req: WebhookRequest,
    secret: string,
    credentials?: GatewayCredentials,
  ): Promise<VerifyResult>;

  /*
   * Traduz o payload para o formato canônico. Devolve `null` quando o evento
   * não interessa (teste de conexão, atualização de assinatura, etc.).
   */
  parse(req: WebhookRequest): Promise<CanonicalOrder | null>;

  /*
   * Consulta o pedido pela API do gateway. Serve para dois momentos: confirmar
   * um webhook sem assinatura, e reconciliar vendas cujo webhook se perdeu.
   * Opcional — nem todo gateway expõe leitura.
   */
  fetchOrder?(orderId: string, credentials: GatewayCredentials): Promise<CanonicalOrder | null>;

  /*
   * Completa uma venda com o que o webhook não trouxe.
   *
   * Existe porque a Appmax não manda comprador nenhum no webhook de pedido —
   * só o pedido. Sem uma consulta à API, a venda chegaria sem e-mail, sem nome
   * e sem documento, e o CAPI receberia só as chaves de navegador.
   *
   * É chamado depois do `parse` e antes da junção, e apenas quando a conexão
   * tem credenciais. Falha aqui não derruba a venda: ela entra com menos
   * chaves, o que é melhor que não entrar.
   */
  enrich?(order: CanonicalOrder, credentials: GatewayCredentials): Promise<CanonicalOrder>;
}

export interface GatewayCredentials {
  apiKey?: string;
  apiSecret?: string;
  accountId?: string;
  [k: string]: string | undefined;
}
