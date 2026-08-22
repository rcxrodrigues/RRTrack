/*
 * O contrato de um destino de conversão.
 *
 * Meta, Google Ads, TikTok, GA4, Pinterest, Kwai — cada um com seu formato,
 * todos alimentados pelos mesmos dados canônicos. Um destino novo é um arquivo
 * novo aqui; nada no resto do sistema muda.
 */

import type { CanonicalOrder, ClickContext } from "../core/types.js";

/** Nomes de evento canônicos, traduzidos por cada destino para o dialeto dele. */
export type ConversionEvent =
  | "page_view"
  | "view_content"
  | "add_to_cart"
  | "initiate_checkout"
  | "add_payment_info"
  | "purchase"
  | "lead"
  | "subscribe";

export interface DispatchInput {
  event: ConversionEvent;
  /** Compartilhado com o navegador quando houver pixel — é o que deduplica. */
  eventId: string;
  occurredAt: Date;
  order?: CanonicalOrder;
  click?: Partial<ClickContext>;
  sourceUrl?: string;
  valueCents?: number;
  currency?: string;
}

export interface DestinationCredentials {
  accessToken?: string;
  [k: string]: string | undefined;
}

export interface DestinationConfig {
  /** Pixel/dataset (Meta), customer id (Google), pixel code (TikTok). */
  externalId: string;
  credentials: DestinationCredentials;
  testEventCode?: string | null;
  config?: Record<string, unknown>;
}

export interface DispatchResult {
  ok: boolean;
  /*
   * Quais chaves de correspondência foram efetivamente enviadas. É o que
   * torna a qualidade de correspondência visível antes de a plataforma
   * publicar o número dela — e o que permite descobrir qual gateway ou qual
   * campanha está entregando dado pobre.
   */
  matchKeys: string[];
  requestBody?: unknown;
  responseBody?: unknown;
  error?: string;
  /** Erro transitório: vale reenfileirar. Erro de payload: não vale. */
  retryable?: boolean;
}

export interface DestinationAdapter {
  platform: string;
  label: string;
  /** Eventos que este destino aceita. */
  supports: readonly ConversionEvent[];
  send(input: DispatchInput, cfg: DestinationConfig): Promise<DispatchResult>;
}
