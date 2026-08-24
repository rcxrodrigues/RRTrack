/*
 * Gasto do TikTok, pela Reporting API.
 *
 * Mesmo objetivo do adaptador da Meta — trazer gasto no grão de anúncio, por
 * dia — mas o formato é bem diferente e três coisas mordem:
 *
 * 1. ERRO COM HTTP 200. Igual à Events API deles: `code` diferente de zero é
 *    recusa, com a mensagem dentro. Confiar no status HTTP faria uma conta com
 *    token inválido parecer uma conta sem gasto.
 *
 * 2. O GASTO VEM COMO STRING, e a paginação é por número de página, não por
 *    cursor — `page_info.total_page` diz quando parar.
 *
 * 3. DIMENSÃO E MÉTRICA VÊM SEPARADAS. O id do anúncio e a data ficam em
 *    `dimensions`; nome, gasto e cliques ficam em `metrics`. Procurar tudo no
 *    mesmo lugar devolve indefinido em silêncio.
 *
 * O nível AUCTION_AD é o equivalente ao `level=ad` da Meta, e é o que casa com
 * o `ad_id` que a UTM trouxe no clique.
 */

import type {
  AdSpendAdapter, CredenciaisAnuncio, JanelaData, LinhaGasto, ResultadoGasto,
} from "./types";

const BASE = "https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/";

const METRICAS = [
  "spend", "impressions", "clicks",
  "campaign_id", "campaign_name",
  "adgroup_id", "adgroup_name",
  "ad_name",
  /* O que o próprio TikTok alega ter gerado, para comparar com o nosso. */
  "complete_payment", "total_complete_payment_rate",
];

interface Linha {
  dimensions?: { ad_id?: string; stat_time_day?: string };
  metrics?: Record<string, string | number | null>;
}

function texto(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  return undefined;
}

/** "12.34" -> 1234. O TikTok manda dinheiro como string, como a Meta. */
function centavos(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function inteiro(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : undefined;
}

/** "2026-08-24 00:00:00" -> "2026-08-24" */
function soData(v: string | undefined): string | undefined {
  return v?.slice(0, 10);
}

export const tiktokAdsAdapter: AdSpendAdapter = {
  platform: "tiktok",
  label: "TikTok Ads",

  async buscarGasto(
    contaId: string,
    credenciais: CredenciaisAnuncio,
    janela: JanelaData,
  ): Promise<ResultadoGasto> {
    const token = credenciais.accessToken;
    if (!token) throw new Error("conta do TikTok sem token de acesso");

    const avisos: string[] = [];
    const linhas: LinhaGasto[] = [];

    /*
     * O TikTok não expõe a moeda no relatório. Fica BRL por padrão e vira
     * aviso: somar dólar com real em silêncio é pior que admitir que não se
     * sabe.
     */
    const moeda = credenciais.moeda ?? "BRL";
    let pagina = 1;
    let totalPaginas = 1;

    while (pagina <= totalPaginas) {
      if (pagina > 40) {
        avisos.push("período longo demais: parei em 40 páginas, reduza o intervalo");
        break;
      }

      const params = new URLSearchParams({
        advertiser_id: contaId.replace(/\D/g, ""),
        report_type: "BASIC",
        /* Grão de anúncio — o mais fino que casa com a UTM. */
        data_level: "AUCTION_AD",
        dimensions: JSON.stringify(["ad_id", "stat_time_day"]),
        metrics: JSON.stringify(METRICAS),
        start_date: janela.de,
        end_date: janela.ate,
        page: String(pagina),
        page_size: "1000",
      });

      const res = await fetch(`${BASE}?${params}`, {
        headers: { "Access-Token": token, "content-type": "application/json" },
      });

      if (!res.ok) {
        throw new Error(`TikTok respondeu ${res.status} ao buscar gasto`);
      }

      const j = await res.json() as {
        code?: number; message?: string;
        data?: { list?: Linha[]; page_info?: { total_page?: number } };
      };

      /* HTTP 200 com erro dentro — a pegadinha da casa. */
      if (typeof j.code === "number" && j.code !== 0) {
        /* 40001/40105 costumam ser token; 40100 é limite de chamadas. */
        if (j.code === 40100) {
          avisos.push("limite de chamadas do TikTok atingido; parte do período não veio");
          break;
        }
        throw new Error(`TikTok code ${j.code}: ${j.message ?? "sem mensagem"}`);
      }

      const lista = j.data?.list ?? [];
      totalPaginas = j.data?.page_info?.total_page ?? 1;

      for (const l of lista) {
        const adId = texto(l.dimensions?.ad_id);
        const data = soData(texto(l.dimensions?.stat_time_day));
        if (!adId || !data) continue;

        const m = l.metrics ?? {};
        linhas.push({
          data,
          adId,
          adName: texto(m.ad_name),
          adsetId: texto(m.adgroup_id),
          adsetName: texto(m.adgroup_name),
          campaignId: texto(m.campaign_id),
          campaignName: texto(m.campaign_name),
          gastoCents: centavos(m.spend),
          impressoes: inteiro(m.impressions),
          cliques: inteiro(m.clicks),
          conversoesPlataforma: inteiro(m.complete_payment),
        });
      }

      pagina++;
    }

    if (moeda !== "BRL") {
      avisos.push(`conta reportando em ${moeda}; somar com faturamento em real não faria sentido`);
    }
    if (linhas.length === 0) {
      avisos.push("nenhum gasto no período — confira se o advertiser_id é o certo");
    }

    return { linhas, moeda, avisos };
  },
};
