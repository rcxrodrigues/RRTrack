/*
 * Gasto do Google Ads, pela Google Ads API.
 *
 * A consulta é em GAQL, uma linguagem própria parecida com SQL. Duas coisas
 * daqui não existem nas outras plataformas:
 *
 * 1. DINHEIRO EM MICROS. `cost_micros` é milionésimos da moeda: R$ 1,50 chega
 *    como 1500000. A Meta e o TikTok mandam string decimal. Tratar micros como
 *    centavos infla o gasto em dez mil vezes — e o ROAS vira zero sem que nada
 *    pareça quebrado.
 *
 * 2. O ANÚNCIO NÃO TEM NOME. Muitos formatos do Google não preenchem
 *    `ad_group_ad.ad.name`, então a tela ficaria com uma coluna de vazios.
 *    Caímos no id, que sempre existe.
 *
 * E a estrutura tem outro nome: o que a Meta chama de conjunto, o Google chama
 * de grupo de anúncios. O `extrairEstrutura` das UTMs já trata isso; aqui a
 * tradução acontece no mapeamento de campo.
 */

import type {
  AdSpendAdapter, CredenciaisAnuncio, JanelaData, LinhaGasto, ResultadoGasto,
} from "./types";
import { accessToken, cabecalhos, soDigitos, VERSAO } from "./google-auth";

const GAQL = `
  SELECT
    segments.date,
    campaign.id, campaign.name,
    ad_group.id, ad_group.name,
    ad_group_ad.ad.id, ad_group_ad.ad.name,
    metrics.cost_micros, metrics.impressions, metrics.clicks,
    metrics.conversions, metrics.conversions_value
  FROM ad_group_ad
  WHERE segments.date BETWEEN '{DE}' AND '{ATE}'
`;

interface Resultado {
  segments?: { date?: string };
  campaign?: { id?: string; name?: string };
  adGroup?: { id?: string; name?: string };
  adGroupAd?: { ad?: { id?: string; name?: string } };
  metrics?: {
    costMicros?: string | number;
    impressions?: string | number;
    clicks?: string | number;
    conversions?: number;
    conversionsValue?: number;
  };
}

/*
 * Micros para centavos. R$ 1,50 chega como 1500000 e precisa virar 150.
 * A divisão é por 10.000, não por 1.000.000 — porque o destino é centavo, não
 * unidade da moeda.
 */
function microsParaCentavos(v: string | number | undefined): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? "0"), 10);
  return Number.isFinite(n) ? Math.round(n / 10_000) : 0;
}

function inteiro(v: string | number | undefined): number | undefined {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : undefined;
}

export const googleAdsAdapter: AdSpendAdapter = {
  platform: "google",
  label: "Google Ads",

  async buscarGasto(
    contaId: string,
    cred: CredenciaisAnuncio,
    janela: JanelaData,
  ): Promise<ResultadoGasto> {
    if (!cred.developerToken) {
      throw new Error("conta do Google sem developer token — ele precisa de aprovação do Google");
    }

    const token = await accessToken(cred);
    const conta = soDigitos(contaId);
    const avisos: string[] = [];
    const linhas: LinhaGasto[] = [];

    let moeda = cred.moeda ?? "BRL";

    /* A moeda vem da conta, e o gasto inteiro depende dela estar certa. */
    try {
      const rConta = await fetch(
        `https://googleads.googleapis.com/${VERSAO}/customers/${conta}/googleAds:search`,
        {
          method: "POST",
          headers: cabecalhos(token, cred),
          body: JSON.stringify({
            query: "SELECT customer.currency_code, customer.time_zone FROM customer LIMIT 1",
          }),
        },
      );
      if (rConta.ok) {
        const j = await rConta.json() as { results?: Array<{ customer?: { currencyCode?: string } }> };
        const c = j.results?.[0]?.customer?.currencyCode;
        if (c) moeda = c;
      }
    } catch {
      avisos.push("não foi possível ler a moeda da conta");
    }

    /* Nao se compara moeda aqui — ver a nota longa em ads/meta.ts. */

    const query = GAQL.replace("{DE}", janela.de).replace("{ATE}", janela.ate);
    let pageToken: string | undefined;
    let paginas = 0;

    do {
      if (paginas++ > 40) {
        avisos.push("período longo demais: parei em 40 páginas, reduza o intervalo");
        break;
      }

      const res = await fetch(
        `https://googleads.googleapis.com/${VERSAO}/customers/${conta}/googleAds:search`,
        {
          method: "POST",
          headers: cabecalhos(token, cred),
          body: JSON.stringify({ query, pageSize: 10_000, ...(pageToken ? { pageToken } : {}) }),
        },
      );

      if (!res.ok) {
        const corpo = await res.text().catch(() => "");
        /*
         * Os três erros que o lojista consegue resolver, cada um com um passo
         * diferente. Devolver "HTTP 403" mandaria ele adivinhar qual dos três é.
         */
        if (corpo.includes("DEVELOPER_TOKEN_NOT_APPROVED")) {
          throw new Error("developer token ainda não aprovado pelo Google");
        }
        if (corpo.includes("USER_PERMISSION_DENIED") || corpo.includes("CUSTOMER_NOT_FOUND")) {
          throw new Error("sem permissão nesta conta, ou id errado — confira também a gerenciadora");
        }
        if (res.status === 429 || corpo.includes("RESOURCE_EXHAUSTED")) {
          avisos.push("limite de chamadas do Google atingido; parte do período não veio");
          break;
        }
        throw new Error(`Google respondeu ${res.status}: ${corpo.slice(0, 200)}`);
      }

      const j = await res.json() as { results?: Resultado[]; nextPageToken?: string };

      for (const r of j.results ?? []) {
        const data = r.segments?.date;
        const adId = r.adGroupAd?.ad?.id;
        if (!data || !adId) continue;

        linhas.push({
          data,
          campaignId: r.campaign?.id,
          campaignName: r.campaign?.name,
          /* Grupo de anúncios é o que a Meta chama de conjunto. */
          adsetId: r.adGroup?.id,
          adsetName: r.adGroup?.name,
          adId,
          /* Muitos formatos não têm nome; o id sempre existe. */
          adName: r.adGroupAd?.ad?.name ?? adId,
          gastoCents: microsParaCentavos(r.metrics?.costMicros),
          impressoes: inteiro(r.metrics?.impressions),
          cliques: inteiro(r.metrics?.clicks),
          conversoesPlataforma: r.metrics?.conversions,
          faturamentoPlataformaCents: r.metrics?.conversionsValue !== undefined
            ? Math.round(r.metrics.conversionsValue * 100)
            : undefined,
        });
      }

      pageToken = j.nextPageToken;
    } while (pageToken);

    if (linhas.length === 0) {
      avisos.push("nenhum gasto no período — confira o id da conta e se houve veiculação");
    }

    return { linhas, moeda, avisos };
  },
};
