/*
 * O coletor. Recebe os beacons do rr.js e mantém a sessão de clique viva.
 *
 * Roda no caminho quente: é chamado em toda página vista de toda loja. Por isso
 * responde 204 sem corpo e faz o mínimo — validar a origem, atualizar a sessão,
 * gravar o evento. Nada de disparo para plataforma acontece aqui.
 */

import { after } from "next/server";
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { clickSessions, events, sites } from "@/db/schema";
import { dispatchBrowserEvent, normalizarEvento } from "@/core/dispatch";
import { ehRobo } from "@/core/robos";
import { ehRedeDaMeta } from "@/core/redes";
import { extrairEstrutura } from "@/core/utm";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/*
 * O beacon é enviado como text/plain de propósito.
 *
 * application/json não está na lista de tipos isentos de verificação prévia do
 * CORS, e navigator.sendBeacon não sabe fazer essa verificação — a requisição
 * simplesmente não sai. Como o coletor vive num subdomínio (t.loja.com.br) e a
 * página noutro (www.loja.com.br), a origem é diferente e a regra vale.
 */
function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

export async function OPTIONS(req: Request): Promise<Response> {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

function clientIp(req: Request): string | undefined {
  /*
   * `cf-connecting-ip` VEM PRIMEIRO, e isso não é preferência de estilo.
   *
   * Com a Cloudflare na frente, o `x-forwarded-for` que chega aqui traz o IP
   * da BORDA DA CLOUDFLARE, não o do visitante — a Vercel reescreve o
   * cabeçalho com o IP de quem falou com ela, e quem falou com ela foi o
   * proxy. O sintoma foi uma loja de Belo Horizonte aparecendo como São Paulo
   * e Rio de Janeiro, que é onde ficam os pontos de presença.
   *
   * O estrago não para no mapa. Este IP vai para a Meta como chave de
   * correspondência: mandar o IP de um data center é pior que não mandar
   * nada, porque associa a compra a um lugar onde ninguém mora.
   *
   * A Cloudflare põe o IP verdadeiro em `cf-connecting-ip`, e ela mesma
   * sobrescreve esse cabeçalho na entrada — então não dá para forjar de fora.
   */
  const daCloudflare = req.headers.get("cf-connecting-ip");
  if (daCloudflare?.trim()) return daCloudflare.trim();

  /* Outros proxies usam este nome para a mesma coisa. */
  const verdadeiro = req.headers.get("true-client-ip");
  if (verdadeiro?.trim()) return verdadeiro.trim();

  /* Sem proxy conhecido, o primeiro da cadeia é o cliente. */
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") ?? undefined;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export async function POST(req: Request): Promise<Response> {
  const headers = corsHeaders(req.headers.get("origin"));

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await req.text()) as Record<string, unknown>;
  } catch {
    return new Response(null, { status: 400, headers });
  }

  const siteKey = str(body.site_key);
  const clickId = str(body.click_id);
  const eventName = str(body.event);

  if (!siteKey || !clickId || !eventName || !UUID_RE.test(clickId)) {
    return new Response(null, { status: 400, headers });
  }

  /*
   * Robô declarado não vira sessão nem evento.
   *
   * Responde 204, e não um erro, de propósito: erro convida a nova tentativa,
   * e a prévia de link da Meta bate na mesma página várias vezes. Do lado de
   * quem chamou não há diferença nenhuma; do nosso, a sessão simplesmente não
   * nasce — e como o descarte acontece ANTES de gravar, nenhuma agregação
   * precisa saber que robô existe. Ver src/core/robos.ts para o porquê.
   */
  const ip = clientIp(req);

  /*
   * Dois cortes, porque são dois tipos de robô.
   *
   * O primeiro se declara no agente — prévia de link, buscador, curl. O
   * segundo NÃO se declara: a revisão de anúncio da Meta abre a página com o
   * mesmo agente do app do Facebook, idêntico ao de um comprador, e só o IP
   * separa. Foi metade do tráfego da primeira semana da Florè.
   *
   * Responde 204, e não erro, de propósito: erro convida a nova tentativa, e a
   * prévia da Meta bate várias vezes na mesma página. Como o descarte acontece
   * ANTES de gravar, nenhuma agregação do painel precisa saber que robô existe.
   */
  if (ehRobo(req.headers.get("user-agent")) || ehRedeDaMeta(ip)) {
    return new Response(null, { status: 204, headers });
  }

  /*
   * A origem precisa ser um site cadastrado. Sem esta checagem, qualquer página
   * na internet poderia despejar eventos falsos na conta de qualquer loja.
   */
  const [site] = await db.select().from(sites).where(eq(sites.publicKey, siteKey)).limit(1);
  if (!site || !site.active) return new Response(null, { status: 403, headers });

  const attr = (body.attribution ?? {}) as Record<string, unknown>;
  const agora = new Date();

  const valores = {
    clickId,
    tenantId: site.tenantId,
    siteId: site.id,
    utmSource: str(attr.utm_source),
    utmMedium: str(attr.utm_medium),
    utmCampaign: str(attr.utm_campaign),
    utmContent: str(attr.utm_content),
    utmTerm: str(attr.utm_term),
    utmId: str(attr.utm_id),
    fbclid: str(attr.fbclid),
    gclid: str(attr.gclid),
    gbraid: str(attr.gbraid),
    wbraid: str(attr.wbraid),
    ttclid: str(attr.ttclid),
    msclkid: str(attr.msclkid),
    twclid: str(attr.twclid),
    epik: str(attr.epik),
    liFatId: str(attr.li_fat_id),
    kwaiClickId: str(attr.kwai_click_id),
    fbp: str(body.fbp),
    fbc: str(body.fbc),
    externalId: str(body.external_id),

    /*
     * Estrutura do anúncio, lida das UTMs conforme a convenção da plataforma.
     * É o que liga esta sessão ao gasto que a API da plataforma reporta — sem
     * isso o painel tem faturamento por campanha e gasto por campanha sem
     * conseguir dividir um pelo outro.
     */
    ...(() => {
      const e = extrairEstrutura({
        utmSource: str(attr.utm_source) ?? undefined,
        utmMedium: str(attr.utm_medium) ?? undefined,
        utmCampaign: str(attr.utm_campaign) ?? undefined,
        utmContent: str(attr.utm_content) ?? undefined,
        utmTerm: str(attr.utm_term) ?? undefined,
      });
      return {
        campaignId: e.campaignId ?? null,
        campaignName: e.campaignName ?? null,
        adsetId: e.adsetId ?? null,
        adsetName: e.adsetName ?? null,
        adId: e.adId ?? null,
        adName: e.adName ?? null,
        placement: e.placement ?? null,
      };
    })(),
    ip: ip ?? null,
    userAgent: req.headers.get("user-agent"),

    /*
     * A Vercel resolve o IP antes da função rodar e entrega o resultado nos
     * cabeçalhos. Sai de graça e sem latência — consultar um banco de IPs aqui
     * acrescentaria uma chamada de rede no caminho mais quente do sistema.
     *
     * O país vem como sigla de duas letras e a região como código curto
     * ("MG"); a cidade vem com escape de URL quando tem acento, então é
     * decodificada antes de gravar.
     */
    country: req.headers.get("x-vercel-ip-country"),
    region: req.headers.get("x-vercel-ip-country-region"),
    city: (() => {
      const c = req.headers.get("x-vercel-ip-city");
      if (!c) return null;
      try { return decodeURIComponent(c); } catch { return c; }
    })(),
    landingUrl: str(attr.landing_url) ?? str(body.page_url),
    referrer: str(body.referrer),
    firstSeenAt: agora,
    lastSeenAt: agora,
  };

  /*
   * COALESCE com o valor novo na frente: dado que chegou agora prevalece, mas
   * um campo vazio nunca apaga o que já existia. É o que impede a segunda
   * visita — sem UTM na URL — de apagar a campanha que trouxe a pessoa.
   */
  const [sessao] = await db.insert(clickSessions).values(valores).onConflictDoUpdate({
    target: clickSessions.clickId,
    set: {
      lastSeenAt: agora,
      utmSource: sql`COALESCE(EXCLUDED.utm_source, ${clickSessions.utmSource})`,
      utmMedium: sql`COALESCE(EXCLUDED.utm_medium, ${clickSessions.utmMedium})`,
      utmCampaign: sql`COALESCE(EXCLUDED.utm_campaign, ${clickSessions.utmCampaign})`,
      utmContent: sql`COALESCE(EXCLUDED.utm_content, ${clickSessions.utmContent})`,
      utmTerm: sql`COALESCE(EXCLUDED.utm_term, ${clickSessions.utmTerm})`,
      fbclid: sql`COALESCE(EXCLUDED.fbclid, ${clickSessions.fbclid})`,
      gclid: sql`COALESCE(EXCLUDED.gclid, ${clickSessions.gclid})`,
      ttclid: sql`COALESCE(EXCLUDED.ttclid, ${clickSessions.ttclid})`,
      fbp: sql`COALESCE(EXCLUDED.fbp, ${clickSessions.fbp})`,
      fbc: sql`COALESCE(EXCLUDED.fbc, ${clickSessions.fbc})`,
      externalId: sql`COALESCE(EXCLUDED.external_id, ${clickSessions.externalId})`,
      campaignId: sql`COALESCE(EXCLUDED.campaign_id, ${clickSessions.campaignId})`,
      campaignName: sql`COALESCE(EXCLUDED.campaign_name, ${clickSessions.campaignName})`,
      adsetId: sql`COALESCE(EXCLUDED.adset_id, ${clickSessions.adsetId})`,
      adsetName: sql`COALESCE(EXCLUDED.adset_name, ${clickSessions.adsetName})`,
      adId: sql`COALESCE(EXCLUDED.ad_id, ${clickSessions.adId})`,
      adName: sql`COALESCE(EXCLUDED.ad_name, ${clickSessions.adName})`,
      placement: sql`COALESCE(EXCLUDED.placement, ${clickSessions.placement})`,
      ip: sql`COALESCE(EXCLUDED.ip, ${clickSessions.ip})`,
      userAgent: sql`COALESCE(EXCLUDED.user_agent, ${clickSessions.userAgent})`,
      country: sql`COALESCE(EXCLUDED.country, ${clickSessions.country})`,
      region: sql`COALESCE(EXCLUDED.region, ${clickSessions.region})`,
      city: sql`COALESCE(EXCLUDED.city, ${clickSessions.city})`,
    },
  }).returning();

  /*
   * O pulso só serve para dizer "ainda estou aqui", e o `lastSeenAt` acima já
   * registrou isso. Gravar um evento por pulso encheria a tabela com uma linha
   * por minuto por visitante — em troca de nada, porque nenhuma tela conta
   * pulso.
   */
  if (eventName === "ping") return new Response(null, { status: 204, headers });

  const eventId = str(body.event_id) ?? `${eventName}.${clickId}.${Date.now()}`;
  const params = (body.params ?? {}) as Record<string, unknown>;
  const valor = typeof params.value === "number" ? Math.round(params.value * 100) : null;

  /* Reenvio do mesmo beacon — acontece com sendBeacon — não vira evento novo. */
  await db.insert(events).values({
    tenantId: site.tenantId,
    clickId,
    name: eventName,
    eventId,
    valueCents: valor,
    currency: str(params.currency),
    pageUrl: str(body.page_url),
    payload: params,
    occurredAt: (() => {
      const t = str(body.occurred_at);
      const d = t ? new Date(t) : agora;
      return Number.isNaN(d.getTime()) ? agora : d;
    })(),
  }).onConflictDoNothing();

  /*
   * O disparo para as plataformas acontece DEPOIS da resposta.
   *
   * `after` deixa o 204 sair na hora e roda o resto em seguida. Sem isso, cada
   * página vista esperaria a Meta responder antes de liberar o navegador — e
   * um pico de tráfego, ou uma lentidão do lado deles, viraria lentidão no site
   * do cliente. O visitante nunca paga o preço do nosso rastreamento.
   */
  const canonico = normalizarEvento(eventName);
  if (canonico && sessao) {
    after(async () => {
      try {
        await dispatchBrowserEvent({
          tenantId: site.tenantId,
          evento: canonico,
          eventId,
          occurredAt: new Date(),
          pageUrl: str(body.page_url) ?? undefined,
          valueCents: valor ?? undefined,
          currency: str(params.currency) ?? undefined,
          contents: lerProdutos(params),
          click: {
            clickId: sessao.clickId,
            fbp: sessao.fbp ?? undefined,
            fbc: sessao.fbc ?? undefined,
            ip: sessao.ip ?? undefined,
            userAgent: sessao.userAgent ?? undefined,
          },
        });
      } catch (e) {
        /* Falha de disparo não pode derrubar a coleta: o evento já está gravado
           e pode ser reprocessado; o visitante já foi embora faz tempo. */
        console.error("[collect] falha ao disparar", e);
      }
    });
  }

  return new Response(null, { status: 204, headers });
}

/*
 * Produtos vindos do site. Aceita o formato de e-commerce do GA4 (`items`,
 * com `item_id` e `price` em reais) e uma forma curta, porque quem instala à
 * mão escreve a curta e quem vem de GTM já tem a do GA4 pronta.
 */
function lerProdutos(params: Record<string, unknown>) {
  const bruto = params.items ?? params.contents ?? params.content_ids;
  if (!Array.isArray(bruto) || bruto.length === 0) return undefined;

  /* Lista de SKUs pura: ["1313", "1414"] */
  if (typeof bruto[0] === "string") {
    return (bruto as string[]).map((id) => ({ id }));
  }

  const out = [];
  for (const it of bruto) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const id = str(o.item_id) ?? str(o.id) ?? str(o.sku);
    if (!id) continue;
    const preco = typeof o.price === "number" ? o.price
      : typeof o.item_price === "number" ? o.item_price : undefined;
    out.push({
      id,
      quantity: typeof o.quantity === "number" ? o.quantity : 1,
      priceCents: preco !== undefined ? Math.round(preco * 100) : undefined,
      name: str(o.item_name) ?? str(o.name) ?? undefined,
    });
  }
  return out.length ? out : undefined;
}
