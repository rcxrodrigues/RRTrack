/*
 * O contrato de um destino de conversão.
 *
 * Meta, Google Ads, TikTok, GA4, Pinterest, Kwai — cada um com seu formato,
 * todos alimentados pelos mesmos dados canônicos. Um destino novo é um arquivo
 * novo aqui; nada no resto do sistema muda.
 */

import type { CanonicalOrder, ClickContext } from "../core/types";

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
  /*
   * Produtos de um evento que não é venda — ver um item, jogar no carrinho.
   * Aqui não existe pedido, então os produtos chegam soltos: é o que permite
   * à Meta casar o evento de navegação com o catálogo e montar remarketing
   * dinâmico. Sem isso o evento chega vazio de conteúdo e serve para pouco.
   */
  contents?: Array<{ id: string; quantity?: number; priceCents?: number; name?: string }>;
}

export interface DestinationCredentials {
  /* Meta e TikTok: token longo e pronto. */
  accessToken?: string;

  /*
   * Google: OAuth2 completo, mais o developer token que precisa de aprovação
   * dele, mais o nome do recurso da ação de conversão. É a integração com mais
   * peças das três — e a única que não funciona no dia em que se cadastra.
   */
  developerToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  loginCustomerId?: string;
  conversionAction?: string;

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

  /*
   * Reenvia um payload que já foi montado e falhou.
   *
   * Recebe o corpo EXATO da tentativa anterior, e não os dados para remontar.
   * A diferença importa: remontar poderia produzir um evento diferente — outro
   * carimbo de tempo, outro custo recalculado — e a plataforma o trataria como
   * evento novo, em vez da mesma conversão que não passou.
   */
  reenviar?(corpo: unknown, cfg: DestinationConfig): Promise<DispatchResult>;
}
