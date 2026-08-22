/*
 * O coletor. Recebe os beacons do rr.js e mantém a sessão de clique viva.
 *
 * Roda no caminho quente: é chamado em toda página vista de toda loja. Por isso
 * responde 204 sem corpo e faz o mínimo — validar a origem, atualizar a sessão,
 * gravar o evento. Nada de disparo para plataforma acontece aqui.
 */

import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { clickSessions, events, sites } from "@/db/schema";

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
  /* Atrás de proxy, o IP real é o primeiro da cadeia do x-forwarded-for. */
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
    ip: clientIp(req) ?? null,
    userAgent: req.headers.get("user-agent"),
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
  await db.insert(clickSessions).values(valores).onConflictDoUpdate({
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
      ip: sql`COALESCE(EXCLUDED.ip, ${clickSessions.ip})`,
      userAgent: sql`COALESCE(EXCLUDED.user_agent, ${clickSessions.userAgent})`,
    },
  });

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

  return new Response(null, { status: 204, headers });
}
