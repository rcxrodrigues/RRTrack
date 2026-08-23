/*
 * Extração da estrutura do anúncio a partir das UTMs.
 *
 * Este módulo existe por causa de um problema que só aparece quando o painel
 * tenta abrir o ROAS por anúncio: o gasto vem da API da plataforma, chaveado
 * por id de campanha, conjunto e anúncio; a venda vem do webhook, chaveada
 * pelo clickId. Não há nada em comum entre os dois.
 *
 * A ponte é a URL do anúncio. Cada plataforma substitui variáveis dinâmicas no
 * momento do clique, e o truque — que a Utmify usa e vale copiar — é empacotar
 * nome e id no mesmo campo, separados por barra vertical:
 *
 *   utm_campaign=Black Friday|120210000012345
 *
 * Legível para quem lê relatório, exato para quem precisa casar com o gasto.
 * O id é o que importa: ele não muda quando o anunciante renomeia a campanha,
 * e o nome muda — quem confia no nome perde o histórico a cada renomeação.
 *
 * A armadilha é que cada plataforma usa os cinco campos de UTM numa ORDEM
 * DIFERENTE. Na Meta o conjunto vai em `utm_medium`; no Google esse mesmo
 * campo carrega o grupo de anúncios; e o Google não manda nome nenhum, só id.
 * Ler `utm_medium` como "meio" e esperar "cpc" ali é o erro que faz o painel
 * inteiro mostrar número errado sem avisar.
 */

export interface EstruturaAnuncio {
  campaignId?: string;
  campaignName?: string;
  adsetId?: string;
  adsetName?: string;
  adId?: string;
  adName?: string;
  placement?: string;
}

/** Divide "nome|id" no ÚLTIMO separador — nome de campanha costuma ter barra. */
function partir(v: string | undefined): { nome?: string; id?: string } {
  if (!v) return {};
  const t = v.trim();
  if (!t) return {};

  const i = t.lastIndexOf("|");
  if (i === -1) {
    /* Sem separador: se for só dígitos é id, senão é nome. */
    return /^\d{5,}$/.test(t) ? { id: t } : { nome: t };
  }

  const nome = t.slice(0, i).trim();
  const id = t.slice(i + 1).trim();
  return { nome: nome || undefined, id: id || undefined };
}

function limpo(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

export type Plataforma = "meta" | "google" | "tiktok" | "kwai" | "desconhecida";

/*
 * Identifica a plataforma pelo utm_source. É o que decide como ler os outros
 * campos, então errar aqui contamina tudo o que vem depois.
 */
export function detectarPlataforma(utmSource: string | undefined): Plataforma {
  const s = (utmSource ?? "").trim().toLowerCase();
  if (!s) return "desconhecida";
  if (s === "fb" || s.includes("facebook") || s.includes("meta") || s.includes("instagram")) return "meta";
  if (s.includes("google") || s === "adwords") return "google";
  if (s.includes("tiktok")) return "tiktok";
  if (s.includes("kwai")) return "kwai";
  return "desconhecida";
}

export interface CamposUtm {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  utmId?: string;
}

/**
 * Lê a estrutura do anúncio conforme a convenção da plataforma de origem.
 */
export function extrairEstrutura(u: CamposUtm): EstruturaAnuncio {
  const plataforma = detectarPlataforma(u.utmSource);

  switch (plataforma) {
    /*
     * Meta e TikTok compartilham o mesmo desenho — campanha, conjunto e
     * anúncio nos três primeiros campos, tudo como "nome|id", posicionamento
     * no term. As variáveis diferem ({{ad.id}} contra __CID__), mas quem
     * substitui é a plataforma; aqui chega igual.
     */
    case "meta":
    case "tiktok":
    case "kwai": {
      const c = partir(u.utmCampaign);
      const cj = partir(u.utmMedium);
      const a = partir(u.utmContent);
      return {
        campaignId: c.id, campaignName: c.nome,
        adsetId: cj.id, adsetName: cj.nome,
        adId: a.id, adName: a.nome,
        placement: limpo(u.utmTerm),
      };
    }

    /*
     * O Google só entrega id — {campaignid}, {adgroupid}, {creative} são
     * números puros, sem nome. E o `utm_term` vem como "posicionamento::palavra",
     * porque a palavra-chave é informação que só a busca tem.
     */
    case "google": {
      const term = limpo(u.utmTerm);
      const placement = term?.includes("::") ? term.split("::")[0]?.trim() : term;
      return {
        campaignId: limpo(u.utmCampaign),
        adsetId: limpo(u.utmMedium),
        adId: limpo(u.utmContent),
        placement: placement || undefined,
      };
    }

    /*
     * Origem que não reconhecemos — tráfego orgânico, e-mail, um parceiro.
     * Não há estrutura de anúncio para extrair, e inventar uma seria pior:
     * a venda apareceria pendurada num anúncio que não existe.
     */
    default:
      return {};
  }
}

/*
 * Os modelos de URL que o anunciante cola no campo de parâmetros de cada
 * plataforma. É daqui que sai o "Código de UTMs" da tela de Integrações.
 *
 * Trocar um destes depois que campanhas já rodaram quebra a continuidade do
 * histórico: as vendas antigas ficam com a leitura antiga. Mudança aqui é
 * mudança de contrato, não de formatação.
 */
export const MODELOS: Record<string, { rotulo: string; modelo: string; nota: string }> = {
  meta: {
    rotulo: "Meta Ads",
    modelo: "utm_source=FB&utm_campaign={{campaign.name}}|{{campaign.id}}&utm_medium={{adset.name}}|{{adset.id}}&utm_content={{ad.name}}|{{ad.id}}&utm_term={{placement}}",
    nota: "Cole em Parâmetros de URL, no nível do anúncio. Vale para Instagram também.",
  },
  google: {
    rotulo: "Google Ads",
    modelo: "{lpurl}?utm_source=google&utm_campaign={campaignid}&utm_medium={adgroupid}&utm_content={creative}&utm_term={placement}::{keyword}&keyword={keyword}&device={device}&network={network}",
    nota: "Cole em Modelo de acompanhamento, no nível da conta. O Google só devolve id, sem nome.",
  },
  tiktok: {
    rotulo: "TikTok Ads",
    modelo: "?utm_source=tiktok&utm_campaign=__CAMPAIGN_NAME__|__CAMPAIGN_ID__&utm_medium=__AID_NAME__|__AID__&utm_content=__CID_NAME__|__CID__&utm_term=__PLACEMENT__&utm_id=__CAMPAIGN_ID__",
    nota: "Cole no campo de URL do anúncio. AID é o conjunto, CID é o criativo.",
  },
  kwai: {
    rotulo: "Kwai Ads",
    modelo: "?utm_source=kwai&utm_campaign=__CAMPAIGN_NAME__|__CAMPAIGN_ID__&utm_medium=__UNIT_NAME__|__UNIT_ID__&utm_content=__CREATIVE_NAME__|__CREATIVE_ID__",
    nota: "Cole no campo de URL de destino do criativo.",
  },
};
