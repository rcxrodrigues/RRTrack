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
  verify(req: WebhookRequest, secret: string): Promise<VerifyResult>;

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
}

export interface GatewayCredentials {
  apiKey?: string;
  apiSecret?: string;
  accountId?: string;
  [k: string]: string | undefined;
}
