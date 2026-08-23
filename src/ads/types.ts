/*
 * O contrato de quem traz o gasto.
 *
 * É a outra metade do painel. As vendas chegam sozinhas, empurradas pelo
 * webhook; o gasto tem de ser buscado, e cada plataforma tem sua própria
 * forma de entregar. Meta, Google, TikTok, Kwai e Taboola viram um arquivo
 * cada em src/ads/, e o resto do sistema só conhece o formato daqui.
 */

export interface JanelaData {
  /** Ambas em AAAA-MM-DD, inclusivas. */
  de: string;
  ate: string;
}

/**
 * Uma linha de gasto: um anúncio, num dia.
 *
 * O grão é sempre o mais fino que a plataforma entrega de forma confiável.
 * Agregar para cima (conjunto, campanha, conta) é soma; desagregar para baixo
 * é impossível — então guardamos fino e somamos na leitura.
 */
export interface LinhaGasto {
  /*
   * Dia no fuso da CONTA DE ANÚNCIO, que é como a plataforma reporta — e que
   * pode não ser o fuso da loja. Guardamos como veio e convertemos na leitura;
   * reinterpretar aqui esconderia a diferença em vez de resolvê-la.
   */
  data: string;

  campaignId?: string;
  campaignName?: string;
  adsetId?: string;
  adsetName?: string;
  adId?: string;
  adName?: string;

  gastoCents: number;
  impressoes?: number;
  cliques?: number;

  /*
   * O que a própria plataforma alega ter gerado. Não é a nossa verdade — a
   * janela de atribuição dela é outra — mas serve para comparar e descobrir
   * quando os dois números divergem demais.
   */
  conversoesPlataforma?: number;
  faturamentoPlataformaCents?: number;
}

export interface ResultadoGasto {
  linhas: LinhaGasto[];
  /** Moeda em que a conta reporta. Misturar moedas silenciosamente é erro grave. */
  moeda: string;
  /** Fuso da conta de anúncio, quando a plataforma informa. */
  fuso?: string;
  avisos: string[];
}

export interface CredenciaisAnuncio {
  accessToken?: string;
  developerToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  [k: string]: string | undefined;
}

export interface AdSpendAdapter {
  platform: string;
  label: string;
  /**
   * Busca o gasto no grão de anúncio.
   * Deve paginar até o fim e devolver tudo — quem chama não sabe paginar.
   */
  buscarGasto(
    contaId: string,
    credenciais: CredenciaisAnuncio,
    janela: JanelaData,
  ): Promise<ResultadoGasto>;
}
