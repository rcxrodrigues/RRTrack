/*
 * A junção entre o clique e a venda.
 *
 * É a peça central: sem ela, o painel tem faturamento sem origem e as
 * plataformas recebem conversão sem as chaves que vieram do navegador.
 *
 * São quatro tentativas, da mais confiável para a mais frouxa. O método que
 * funcionou fica gravado na venda, porque um número atribuído por chave não
 * vale o mesmo que um atribuído por palpite — e o painel precisa poder
 * mostrar essa diferença em vez de escondê-la numa média.
 */

import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "../db/index";
import { clickSessions, orderClaims } from "../db/schema";
import type { CanonicalOrder } from "./types";

export type AttributionMethod =
  | "click_id"
  | "order_claim"
  | "fbp_match"
  | "gateway_attribution"
  | "unattributed";

export type ClickSession = typeof clickSessions.$inferSelect;

export interface ResolvedAttribution {
  method: AttributionMethod;
  clickId?: string;
  session?: ClickSession;
  /*
   * Comprador que a loja informou ao reivindicar o pedido, ainda cifrado.
   * É o caminho do endereço, que nenhum gateway devolve.
   */
  compradorDaLoja?: Record<string, string> | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/*
 * Extrai candidatos a clickId dos campos de repasse.
 *
 * Não sabemos em qual campo o gateway devolveu — configuramos `sck`, mas o
 * lojista pode ter posto em `src`, e alguns gateways renomeiam. Então olhamos
 * todos os valores e ficamos com os que têm cara de UUID. O formato é
 * específico o bastante para não haver falso positivo: um código de afiliado
 * não se parece com um UUID v4.
 */
function candidateClickIds(order: CanonicalOrder): string[] {
  const out: string[] = [];
  for (const value of Object.values(order.passthrough)) {
    const v = value.trim();
    if (UUID_RE.test(v)) out.push(v.toLowerCase());
  }
  return [...new Set(out)];
}

/*
 * Janela de retrocesso para a correspondência por fbp.
 *
 * Trinta dias porque é o horizonte em que uma compra ainda se explica pelo
 * clique — e porque o mesmo navegador pode ter várias sessões; sem limite,
 * pegaríamos uma visita de meses atrás e daríamos crédito à campanha errada.
 */
const FBP_WINDOW_DAYS = 30;

export async function resolveAttribution(
  tenantId: string,
  order: CanonicalOrder,
  gateway?: string,
): Promise<ResolvedAttribution> {
  /* 1. O clickId voltou pelo repasse. É certeza, não inferência. */
  for (const candidate of candidateClickIds(order)) {
    const [found] = await db
      .select()
      .from(clickSessions)
      .where(and(eq(clickSessions.clickId, candidate), eq(clickSessions.tenantId, tenantId)))
      .limit(1);

    if (found) return { method: "click_id", clickId: found.clickId, session: found };
  }

  /*
   * 2. A loja reivindicou o pedido no momento em que o criou.
   *
   * Tão confiável quanto o repasse — é a mesma informação, só que entregue por
   * outro caminho. Existe porque há gateway que não devolve nada, e sem isto a
   * venda por lá seria órfã sempre. Fica com nome próprio para o painel poder
   * distinguir de onde veio a certeza.
   */
  if (gateway) {
    const [reivindicado] = await db
      .select({ clickId: orderClaims.clickId, customer: orderClaims.customer })
      .from(orderClaims)
      .where(and(
        eq(orderClaims.tenantId, tenantId),
        eq(orderClaims.gateway, gateway),
        eq(orderClaims.gatewayOrderId, order.gatewayOrderId),
      ))
      .limit(1);

    if (reivindicado) {
      const [sessao] = await db
        .select()
        .from(clickSessions)
        .where(eq(clickSessions.clickId, reivindicado.clickId))
        .limit(1);

      if (sessao) {
        return {
          method: "order_claim",
          clickId: sessao.clickId,
          session: sessao,
          compradorDaLoja: reivindicado.customer,
        };
      }
    }
  }

  /*
   * 3. O gateway devolveu o fbp. Vale procurar a sessão por ele: além dos
   *    UTMs, recupera ip, user-agent e fbc — que o gateway não manda e que
   *    fazem diferença real na correspondência.
   */
  const fbp = order.attribution?.fbp;
  if (fbp) {
    const desde = new Date(Date.now() - FBP_WINDOW_DAYS * 86400_000);
    const [found] = await db
      .select()
      .from(clickSessions)
      .where(and(
        eq(clickSessions.tenantId, tenantId),
        eq(clickSessions.fbp, fbp),
        gte(clickSessions.lastSeenAt, desde),
      ))
      /* A mais recente: último clique é a regra do painel. */
      .orderBy(desc(clickSessions.lastSeenAt))
      .limit(1);

    if (found) return { method: "fbp_match", clickId: found.clickId, session: found };
  }

  /*
   * 4. Sem sessão nossa, mas o gateway registrou a origem no checkout. Dá para
   *    creditar a campanha no painel; não dá para enriquecer o CAPI, porque
   *    não há fbp, ip nem user-agent.
   */
  const a = order.attribution;
  if (a && (a.utmSource || a.utmCampaign || a.fbclid || a.gclid || a.ttclid)) {
    return { method: "gateway_attribution" };
  }

  /*
   * 5. Órfã. Continua valendo como faturamento — a venda existe — mas não
   *    entra em nenhum ROAS por campanha, e é o número a vigiar: órfã demais
   *    significa que o carimbo no checkout parou de funcionar.
   */
  return { method: "unattributed" };
}

/**
 * Monta o contexto de clique para o disparo, misturando o que a sessão sabe
 * com o que o gateway devolveu. A sessão tem prioridade: ela viu o clique de
 * verdade, enquanto o gateway só recebeu o que a URL carregava.
 */
export function mergeClickContext(
  resolved: ResolvedAttribution,
  order: CanonicalOrder,
): Record<string, string | undefined> {
  const s = resolved.session;
  const a = order.attribution ?? {};

  return {
    clickId: s?.clickId ?? resolved.clickId,
    utmSource: s?.utmSource ?? a.utmSource,
    utmMedium: s?.utmMedium ?? a.utmMedium,
    utmCampaign: s?.utmCampaign ?? a.utmCampaign,
    utmContent: s?.utmContent ?? a.utmContent,
    utmTerm: s?.utmTerm ?? a.utmTerm,
    fbclid: s?.fbclid ?? a.fbclid,
    gclid: s?.gclid ?? a.gclid,
    ttclid: s?.ttclid ?? a.ttclid,
    fbp: s?.fbp ?? a.fbp,
    fbc: s?.fbc ?? a.fbc,
    ip: s?.ip ?? undefined,
    userAgent: s?.userAgent ?? undefined,
    landingUrl: s?.landingUrl ?? a.landingUrl,
  };
}
