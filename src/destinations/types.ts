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

/*
 * O que uma verificação de credencial devolve.
 *
 * `detalhe` é o que a plataforma respondeu, em texto curto — o nome do pixel
 * quando deu certo, a mensagem de erro dela quando não deu. Sem isso o botão
 * diria só "falhou", e "falhou" não distingue token vencido de pixel que
 * pertence a outra conta, que são problemas com soluções opostas.
 */
export interface ResultadoTeste {
  ok: boolean;
  detalhe: string;
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

  /*
   * Confere a credencial sem enviar conversão nenhuma.
   *
   * Existe por causa de uma assimetria: cadastrar token errado não dá erro em
   * lugar nenhum. A tela salva, o painel fica verde, e a descoberta acontece
   * dias depois, quando alguém compara o número da plataforma com o nosso e
   * não bate. A única forma de saber é perguntar à plataforma — e é isso que
   * este método faz.
   *
   * Tem de ser uma chamada de LEITURA. Um teste que dispara evento suja o
   * pixel com conversão que não existiu, e aí a ferramenta de diagnóstico vira
   * fonte de erro nos dados.
   *
   * Também é o que torna seguro subir a versão da API em `core/versoes.ts`: a
   * versão viaja na URL, então uma versão que a plataforma não reconhece falha
   * exatamente aqui, na hora, e não no próximo disparo real.
   */
  testar?(cfg: DestinationConfig): Promise<ResultadoTeste>;
}
