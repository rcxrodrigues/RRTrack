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
import { dominioRegistravel, mesmoSite } from "@/core/dominio";
import { dispatchBrowserEvent, normalizarEvento } from "@/core/dispatch";
import { ehRobo } from "@/core/robos";
import { ehRedeDaMeta } from "@/core/redes";
import { extrairEstrutura } from "@/core/utm";
import { ipDoCliente } from "@/core/ip";
import { TETOS, cabeNoLimite, contar, estourou, respostaDeEstouro } from "@/core/contencao";

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
    /*
     * Sem isto o `Set-Cookie` da resposta é DESCARTADO pelo navegador quando a
     * requisição vem de outra origem — que é o caso normal aqui, com a página
     * em www.loja.com.br e o coletor em t.loja.com.br. O cabeçalho sairia,
     * o navegador o ignoraria, e o cookie continuaria valendo 24 h no Safari
     * sem nada indicar por quê.
     *
     * O par obrigatório é `allow-origin` com a origem EXATA, nunca "*" —
     * a especificação recusa a combinação de "*" com credencial. É por isso
     * que a linha acima ecoa a origem em vez de fixar o curinga.
     */
    "access-control-allow-credentials": "true",
    vary: "origin",
  };
}

/*
 * Devolve um cookie de verdade, quando isso ADIANTA alguma coisa.
 *
 * O problema que resolve: `_rr_cid` e `_rr_eid` são escritos por JavaScript em
 * rr.js, e o
 * Safari limita cookie escrito por script a 7 dias — ou 24 HORAS quando a
 * pessoa chegou por link com parâmetro de rastreamento, que é precisamente o
 * tráfego pago com `?fbclid=`. O cookie é pensado para 90 dias e é ele que faz
 * a venda encontrar o anúncio; expirando em 24 h, a atribuição some sem erro
 * em lugar nenhum.
 *
 * O que levanta esse limite não é de onde o SCRIPT vem, é de onde o COOKIE vem:
 * `Set-Cookie` numa resposta do mesmo site não é cortado. Por isso a troca de
 * endereço do snippet sozinha não resolveria nada — as duas metades andam
 * juntas.
 *
 * TRÊS CONDIÇÕES, e cada uma fecha um buraco:
 *
 * 1. O domínio do cookie vem de `sites.domain`, do BANCO — nunca do pedido.
 *    Tirá-lo do host da requisição deixaria quem tivesse uma chave de site
 *    gravar cookie em qualquer domínio.
 *
 * 2. A requisição tem de ter CHEGADO num host dentro desse domínio. Fora dele
 *    o navegador recusa o cookie de qualquer jeito; mandar o cabeçalho seria
 *    só gastar bytes e esconder que o subdomínio não está configurado.
 *
 * 3. A ORIGEM tem de ser do mesmo domínio. Sem esta, uma página qualquer na
 *    internet poderia fixar o clickId de um visitante da loja — e toda venda
 *    dele passaria a ser creditada ao anúncio que o atacante escolhesse.
 */
function cookieDePrimeiraParte(
  req: Request,
  dominioDoSite: string,
  nome: string,
  valor: string,
): string | null {
  /*
   * `dominioRegistravel` limpa o valor antes de partir: `sites.domain` chega
   * como "https://transforlar.com/" em parte das linhas, e a barra final ia
   * parar dentro do `Domain=` do cookie — que o navegador descarta calado.
   */
  const registravel = dominioRegistravel(dominioDoSite);
  if (!registravel) return null;

  const host = req.headers.get("host");
  if (!host || !mesmoSite(host, registravel)) return null;

  const origem = req.headers.get("origin");
  if (origem) {
    try {
      if (!mesmoSite(new URL(origem).hostname, registravel)) return null;
    } catch { return null; }
  }

  /* 90 dias, o mesmo COOKIE_DAYS de rr.js. Lax para sobreviver à volta do
     gateway; Strict o esconderia justamente na volta, que é quando serve. */
  return `${nome}=${encodeURIComponent(valor)}`
    + `; Domain=.${registravel}; Path=/; Max-Age=${90 * 86400}`
    + "; SameSite=Lax; Secure";
}

export async function OPTIONS(req: Request): Promise<Response> {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}


function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export async function POST(req: Request): Promise<Response> {
  /*
   * `Headers`, e não objeto simples: são DOIS cookies, e chave repetida num
   * objeto sobrescreve em vez de somar — o segundo cookie sumiria calado.
   */
  const headers = new Headers(corsHeaders(req.headers.get("origin")));

  /*
   * O teto de corpo vem ANTES de ler o corpo, quando o `content-length` diz o
   * tamanho — não adianta recusar 50 MB depois de já tê-los na memória.
   */
  if (!cabeNoLimite(req.headers.get("content-length"))) {
    return new Response(null, { status: 413, headers });
  }

  let body: Record<string, unknown>;
  try {
    const bruto = await req.text();
    /*
     * De novo, agora com o tamanho real: `Transfer-Encoding: chunked` não
     * declara `content-length`, e confiar só no cabeçalho deixaria a porta
     * aberta para quem simplesmente o omite.
     *
     * `.length` conta unidades UTF-16, que em UTF-8 nunca são MAIS que os
     * bytes — então este corte pode deixar passar um corpo um pouco maior que
     * o teto, e nunca recusa um menor. É o lado certo para errar.
     */
    if (!cabeNoLimite(null, bruto.length)) {
      return new Response(null, { status: 413, headers });
    }
    body = JSON.parse(bruto) as Record<string, unknown>;
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
   * A chave de site tem formato, e conferi-lo aqui não é preciosismo.
   *
   * A contenção conta POR chave de site, e a chave vem do pedido. Sem este
   * corte, quem mandasse uma chave inventada diferente a cada requisição
   * criaria uma linha nova em `rate_limits` por chamada — a contenção viraria
   * o vetor. Recusar antes de tocar no banco fecha isso e ainda economiza a
   * consulta em cima de lixo.
   *
   * Propositalmente FROUXO: as chaves em produção são "pk_" + hexadecimal, mas
   * a semente usa "pk_teste_…" e um dia pode surgir outro prefixo. Recusar uma
   * chave legítima seria perda silenciosa de coleta — o beacon some, nada dá
   * erro, e a venda vira tráfego direto.
   */
  if (!/^pk_[A-Za-z0-9_]{4,64}$/.test(siteKey)) {
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
  const ip = ipDoCliente(req);

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
  /*
   * A contenção viaja JUNTO da busca do site, numa requisição só.
   *
   * `db.batch()` manda os três comandos no mesmo pedido HTTP, dentro de uma
   * transação — então contar não custa uma ida a mais ao banco no caminho mais
   * quente do sistema. (`db.transaction()` não serve: o driver HTTP do Neon
   * lança "No transactions support" nele. `batch` é o que existe.)
   *
   * E FALHA ABERTO. Se o batch quebrar por qualquer motivo — tabela que ainda
   * não migrou, por exemplo — cai-se na busca sozinha, que é exatamente o que
   * esta rota fazia antes. Contenção que derruba coleta protege o banco e perde
   * a venda: a troca errada. O teto existe contra abuso, não contra o cliente.
   */
  const agora_ms = Date.now();
  let site: typeof sites.$inferSelect | undefined;
  let contido = false;

  try {
    const [porIp, porLoja, achados] = await db.batch([
      contar({ ...TETOS.coletaPorIp, quem: ip ?? "sem-ip" }, agora_ms),
      contar({ ...TETOS.coletaPorLoja, quem: siteKey }, agora_ms),
      db.select().from(sites).where(eq(sites.publicKey, siteKey)).limit(1),
    ]);
    site = achados[0];
    contido = estourou(porIp[0]?.contagem, TETOS.coletaPorIp.teto)
      || estourou(porLoja[0]?.contagem, TETOS.coletaPorLoja.teto);
  } catch (e) {
    console.error("[collect] contenção indisponível, seguindo sem ela:",
      e instanceof Error ? e.message : String(e));
    [site] = await db.select().from(sites).where(eq(sites.publicKey, siteKey)).limit(1);
  }

  if (contido) {
    return respostaDeEstouro(agora_ms, TETOS.coletaPorIp.segundos, headers);
  }

  if (!site || !site.active) return new Response(null, { status: 403, headers });

  /*
   * Daqui para baixo TODA resposta carrega o cookie, inclusive o 204 do pulso.
   * É de propósito: o pulso é o que mantém o prazo rolando em quem ficou na
   * página sem clicar em nada, e é também o único evento que chega de uma aba
   * aberta há horas — justo a visita que o limite de 24 h mataria.
   */
  const externalId = str(body.external_id);
  const cookies = [
    cookieDePrimeiraParte(req, site.domain, "_rr_cid", clickId),
    /*
     * O external_id entra junto, e não é detalhe. Ele vai hasheado no CAPI
     * como chave de correspondência; renascendo a cada 24 h, a Meta vê uma
     * pessoa NOVA por dia — a correspondência despenca e a otimização da
     * campanha piora, sem nada no painel indicando por quê. Mesmo remédio,
     * mesma linha.
     */
    externalId ? cookieDePrimeiraParte(req, site.domain, "_rr_eid", externalId) : null,
  ].filter((c): c is string => c !== null);
  for (const c of cookies) headers.append("set-cookie", c);

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

    /*
     * Os dois do GA4, lidos dos cookies `_ga` e `_ga_<ID>` pelo rr.js.
     *
     * Vêm quase sempre VAZIOS no primeiro beacon: o gtag.js carrega assíncrono
     * e o nosso pulso costuma sair antes de o cookie existir. Por isso eles são
     * COALESCE lá embaixo como todo o resto — o segundo beacon da mesma sessão
     * preenche, e nenhum beacon posterior sem eles apaga o que já veio.
     *
     * Diferente de `fbp`, aqui não se GERA nada quando falta: client_id
     * inventado abre um usuário novo no GA4 a cada compra, e a origem do
     * tráfego fica com o id antigo. Ver o cabeçalho de src/destinations/ga4.ts.
     */
    gaClientId: str(body.ga_client_id),
    gaSessionId: str(body.ga_session_id),
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
    /*
     * A CLOUDFLARE VEM PRIMEIRO, pelo mesmo motivo do IP logo acima.
     *
     * Os cabeçalhos `x-vercel-ip-*` são calculados a partir do IP que a VERCEL
     * enxerga — e com a Cloudflare na frente, esse IP é o da borda do proxy.
     * O resultado foi uma pessoa em Belo Horizonte aparecendo em São Paulo e
     * no Rio: são as cidades dos pontos de presença, não a dela.
     *
     * Corrigir o IP gravado não bastou: a cidade vinha por outro caminho, e
     * continuou errada. Aqui a Cloudflare resolve a localização a partir do
     * visitante de verdade, antes de encaminhar.
     *
     * `cf-ipcountry` a Cloudflare manda sempre. Cidade e região dependem de
     * "Add visitor location headers" estar ligado nas Managed Transforms —
     * sem isso estes dois voltam vazios e caímos na Vercel, que é o
     * comportamento antigo, errado do mesmo jeito. Por isso a tela de Saúde
     * precisa poder dizer que está assim.
     */
    country: req.headers.get("cf-ipcountry")
      ?? req.headers.get("x-vercel-ip-country"),
    region: req.headers.get("cf-region-code")
      ?? req.headers.get("x-vercel-ip-country-region"),
    city: (() => {
      const c = req.headers.get("cf-ipcity") ?? req.headers.get("x-vercel-ip-city");
      if (!c) return null;
      /* Vem com escape de URL quando tem acento. */
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
      /*
       * Aqui o COALESCE vale mais do que nos outros campos.
       *
       * O primeiro beacon quase nunca traz o `_ga` — o gtag.js ainda está
       * carregando. Sem COALESCE, esse primeiro beacon gravaria nulo e o
       * segundo, já com o cookie, seria o único a preencher; qualquer beacon
       * posterior (um pulso de aba parada, por exemplo) apagaria de novo. A
       * compra chegaria horas depois sem client_id, e o adaptador do GA4
       * recusaria o envio — com razão, e por defeito nosso.
       *
       * E o valor novo vem na frente de propósito no `session_id`: quando a
       * pessoa volta em outra sessão do GA4, é a sessão NOVA que interessa.
       */
      gaClientId: sql`COALESCE(EXCLUDED.ga_client_id, ${clickSessions.gaClientId})`,
      gaSessionId: sql`COALESCE(EXCLUDED.ga_session_id, ${clickSessions.gaSessionId})`,
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
