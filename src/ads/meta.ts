/*
 * Gasto da Meta, pela Marketing API.
 *
 * Pede no grão de anúncio e por dia (`level=ad`, `time_increment=1`). É o mais
 * fino que ela entrega de forma confiável, e é o que permite casar com o
 * `ad_id` que a UTM trouxe no clique. Somar para campanha depois é aritmética;
 * dividir campanha em anúncios depois seria adivinhação.
 *
 * Três coisas nesta API mordem quem não presta atenção:
 *
 * 1. `spend` vem como STRING, na moeda da conta — "1234.56", não centavos.
 *    Tratar como número direto arredonda errado, e assumir BRL numa conta em
 *    dólar mistura moedas em silêncio.
 *
 * 2. A data é o dia no fuso da CONTA DE ANÚNCIO, que pode não ser o da loja.
 *    Uma conta em UTC e uma loja em São Paulo divergem em três horas todo dia,
 *    e o gasto da madrugada cai no dia errado.
 *
 * 3. As conversões que ela reporta vêm da janela de atribuição DELA — 7 dias
 *    de clique mais 1 de visualização, por padrão. Não é o mesmo número que o
 *    nosso, e nunca vai ser. Guardamos para comparar, não para somar.
 */

import type {
  AdSpendAdapter, CredenciaisAnuncio, JanelaData, LinhaGasto, ResultadoGasto,
} from "./types";

const VERSAO = process.env.META_GRAPH_VERSION ?? "v23.0";

const CAMPOS = [
  "spend", "impressions", "clicks",
  "campaign_id", "campaign_name",
  "adset_id", "adset_name",
  "ad_id", "ad_name",
  "date_start",
  "actions", "action_values",
].join(",");

interface LinhaBruta {
  spend?: string;
  impressions?: string;
  clicks?: string;
  campaign_id?: string; campaign_name?: string;
  adset_id?: string; adset_name?: string;
  ad_id?: string; ad_name?: string;
  date_start?: string;
  actions?: Array<{ action_type: string; value: string }>;
  action_values?: Array<{ action_type: string; value: string }>;
}

/** "1234.56" -> 123456. Passa por string para não herdar erro de ponto flutuante. */
function paraCentavos(v: string | undefined): number {
  if (!v) return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/*
 * Lê o cabeçalho de uso da Meta.
 *
 * Ele vem como JSON com uma entrada por conta, cada uma trazendo três medidas
 * em porcentagem — chamadas, tempo total e tempo de CPU — e, quando já houve
 * bloqueio, os minutos que faltam para voltar. A pior das três é a que manda:
 * estourar qualquer uma bloqueia.
 */
function lerUso(cabecalho: string | null): { pct: number; esperaMin: number } | null {
  if (!cabecalho) return null;
  try {
    const j = JSON.parse(cabecalho) as Record<string, Array<{
      call_count?: number; total_time?: number; total_cputime?: number;
      estimated_time_to_regain_access?: number;
    }>>;

    let pct = 0;
    let esperaMin = 0;
    for (const entradas of Object.values(j)) {
      for (const e of entradas ?? []) {
        pct = Math.max(pct, e.call_count ?? 0, e.total_time ?? 0, e.total_cputime ?? 0);
        esperaMin = Math.max(esperaMin, e.estimated_time_to_regain_access ?? 0);
      }
    }
    return { pct, esperaMin };
  } catch {
    return null;
  }
}

/*
 * Onde paramos por conta própria.
 *
 * A 80% ainda há folga para outra coisa precisar da cota — uma reconciliação,
 * um teste, uma segunda conta. Parar com o painel um pouco desatualizado é
 * muito melhor que ser bloqueado e ficar sem nada por meia hora.
 */
const LIMITE_PRUDENTE = 80;

function inteiro(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

/*
 * `actions` traz vários tipos de conversão no mesmo array. O que interessa é
 * compra — e ela aparece com nomes diferentes conforme a origem: `purchase`
 * agrega tudo, `omni_purchase` inclui app e loja física. Ficamos com `purchase`
 * e caímos em `omni_purchase` só quando o primeiro não veio, para não somar a
 * mesma venda duas vezes.
 */
function acao(lista: Array<{ action_type: string; value: string }> | undefined): number | undefined {
  if (!lista?.length) return undefined;
  const achar = (t: string) => lista.find((a) => a.action_type === t)?.value;
  const v = achar("purchase") ?? achar("omni_purchase");
  if (!v) return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

export const metaAdsAdapter: AdSpendAdapter = {
  platform: "meta",
  label: "Meta Ads",

  async buscarGasto(
    contaId: string,
    credenciais: CredenciaisAnuncio,
    janela: JanelaData,
  ): Promise<ResultadoGasto> {
    const token = credenciais.accessToken;
    if (!token) throw new Error("conta da Meta sem token de acesso");

    /* A API quer o prefixo act_; o lojista quase sempre cola sem ele. */
    const conta = contaId.startsWith("act_") ? contaId : `act_${contaId}`;
    const avisos: string[] = [];

    /* Moeda e fuso vêm da conta, não do relatório — e mudam a leitura de tudo. */
    let moeda = "BRL";
    let fuso: string | undefined;

    try {
      const rConta = await fetch(
        `https://graph.facebook.com/${VERSAO}/${conta}?fields=currency,timezone_name`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (rConta.ok) {
        const j = await rConta.json() as { currency?: string; timezone_name?: string };
        if (j.currency) moeda = j.currency;
        if (j.timezone_name) fuso = j.timezone_name;
      }
    } catch {
      avisos.push("não foi possível ler moeda e fuso da conta");
    }

    if (moeda !== "BRL") {
      avisos.push(
        `a conta reporta em ${moeda}, não em BRL — o gasto entra na moeda original ` +
        `e somar com faturamento em real daria número sem sentido`,
      );
    }

    const params = new URLSearchParams({
      level: "ad",
      fields: CAMPOS,
      time_range: JSON.stringify({ since: janela.de, until: janela.ate }),
      /* Uma linha por dia. Sem isto a API devolve o período inteiro somado. */
      time_increment: "1",
      limit: "500",
    });

    const linhas: LinhaGasto[] = [];
    let url: string | null =
      `https://graph.facebook.com/${VERSAO}/${conta}/insights?${params}`;
    let paginas = 0;
    let usoPct: number | undefined;
    let bloqueadoAte: Date | undefined;

    while (url) {
      /*
       * Teto de páginas. Uma conta grande com período longo pagina muito, e
       * uma sincronização que roda para sempre trava o worker e estoura o
       * limite de chamadas. Melhor devolver o que deu e avisar.
       */
      if (paginas++ > 40) {
        avisos.push("período longo demais: parei em 40 páginas, reduza o intervalo");
        break;
      }

      const r: Response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });

      const uso = lerUso(r.headers.get("x-business-use-case-usage"));
      if (uso) {
        usoPct = uso.pct;
        if (uso.esperaMin > 0) {
          bloqueadoAte = new Date(Date.now() + uso.esperaMin * 60_000);
          avisos.push(`a Meta bloqueou por ${uso.esperaMin} min; parando aqui`);
          break;
        }
        if (uso.pct >= LIMITE_PRUDENTE) {
          avisos.push(`${uso.pct}% da cota da Meta consumida; parei antes de estourar`);
          break;
        }
      }

      if (!r.ok) {
        const corpo = await r.text().catch(() => "");
        /* 190 é token inválido ou expirado — o erro mais comum aqui, e o único
           que o lojista consegue resolver sozinho. Vale dizer o nome. */
        if (corpo.includes('"code":190')) {
          throw new Error("token da Meta expirado ou revogado — gere outro no Business Manager");
        }
        /*
         * 80000 e 80004 são os códigos de limite de uso da Marketing API.
         * Guardamos o bloqueio para não tentar de novo: insistir durante ele
         * aumenta a espera, segundo a própria documentação da Meta.
         */
        if (r.status === 429 || corpo.includes("80000") || corpo.includes("80004") || corpo.includes("throttl")) {
          const espera = uso?.esperaMin && uso.esperaMin > 0 ? uso.esperaMin : 30;
          bloqueadoAte = new Date(Date.now() + espera * 60_000);
          avisos.push(`limite da Meta atingido; nova tentativa só em ${espera} min`);
          break;
        }
        throw new Error(`Meta respondeu ${r.status}: ${corpo.slice(0, 200)}`);
      }

      const j = await r.json() as { data?: LinhaBruta[]; paging?: { next?: string } };

      for (const b of j.data ?? []) {
        if (!b.date_start) continue;
        linhas.push({
          data: b.date_start,
          campaignId: b.campaign_id,
          campaignName: b.campaign_name,
          adsetId: b.adset_id,
          adsetName: b.adset_name,
          adId: b.ad_id,
          adName: b.ad_name,
          gastoCents: paraCentavos(b.spend),
          impressoes: inteiro(b.impressions),
          cliques: inteiro(b.clicks),
          conversoesPlataforma: acao(b.actions),
          faturamentoPlataformaCents: (() => {
            const v = acao(b.action_values);
            return v !== undefined ? Math.round(v * 100) : undefined;
          })(),
        });
      }

      url = j.paging?.next ?? null;
    }

    if (linhas.length === 0) {
      avisos.push("nenhum gasto no período — confira se a conta é a certa e se houve veiculação");
    }

    return { linhas, moeda, fuso, avisos, usoPct, bloqueadoAte };
  },
};
