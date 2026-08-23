/*
 * Traz o gasto das plataformas para o banco.
 *
 * Roda periodicamente, não a cada visita: as APIs de anúncio têm limite de
 * chamadas e latência de minutos, e um painel que consultasse a Meta a cada
 * carregamento seria lento e seria bloqueado.
 *
 * A janela padrão é de sete dias para trás, e não só de hoje, porque as
 * plataformas REVISAM números já publicados — clique inválido é estornado,
 * conversão atrasada é atribuída depois. Buscar só o dia corrente congelaria
 * dado errado para sempre.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db/index";
import { adAccounts, adSpendDaily } from "../db/schema";
import { getAdSpend } from "../ads/registry";
import { decryptRecord } from "./crypto";

export interface ResumoSync {
  conta: string;
  plataforma: string;
  linhas: number;
  gastoTotalCents: number;
  moeda: string;
  avisos: string[];
  erro?: string;
}

/** AAAA-MM-DD de N dias atrás, em UTC. */
function diaUtc(deslocamento = 0): string {
  const d = new Date(Date.now() + deslocamento * 86400_000);
  return d.toISOString().slice(0, 10);
}

export async function sincronizarGasto(
  tenantId: string,
  opcoes: { dias?: number; plataforma?: string } = {},
): Promise<ResumoSync[]> {
  const dias = Math.min(Math.max(opcoes.dias ?? 7, 1), 90);
  const janela = { de: diaUtc(-dias), ate: diaUtc(0) };

  const contas = await db.select().from(adAccounts).where(and(
    eq(adAccounts.tenantId, tenantId),
    eq(adAccounts.active, true),
    ...(opcoes.plataforma ? [eq(adAccounts.platform, opcoes.plataforma)] : []),
  ));

  const resumos: ResumoSync[] = [];

  for (const conta of contas) {
    const adapter = getAdSpend(conta.platform);
    if (!adapter) {
      resumos.push({
        conta: conta.label, plataforma: conta.platform, linhas: 0,
        gastoTotalCents: 0, moeda: "?", avisos: [],
        erro: `sem adaptador de gasto para ${conta.platform}`,
      });
      continue;
    }

    try {
      const cred = await decryptRecord(conta.credentials);
      const r = await adapter.buscarGasto(conta.externalId, cred, janela);

      for (const l of r.linhas) {
        /*
         * O índice único é (conta, dia, anúncio). Linha sem anúncio não pode
         * entrar: no Postgres nulos não colidem entre si, então ela duplicaria
         * a cada sincronização e inflaria o gasto em silêncio — o pior tipo de
         * erro num painel de ROAS.
         */
        if (!l.adId) continue;

        await db.insert(adSpendDaily).values({
          tenantId,
          adAccountId: conta.id,
          platform: conta.platform,
          date: l.data,
          campaignId: l.campaignId ?? null,
          campaignName: l.campaignName ?? null,
          adsetId: l.adsetId ?? null,
          adsetName: l.adsetName ?? null,
          adId: l.adId,
          adName: l.adName ?? null,
          spendCents: l.gastoCents,
          impressions: l.impressoes ?? null,
          clicks: l.cliques ?? null,
          platformConversions: l.conversoesPlataforma ?? null,
          platformRevenueCents: l.faturamentoPlataformaCents ?? null,
          syncedAt: new Date(),
        }).onConflictDoUpdate({
          target: [adSpendDaily.adAccountId, adSpendDaily.date, adSpendDaily.adId],
          /* Sobrescreve de propósito: a plataforma revisa números publicados,
             e a última leitura é a boa. */
          set: {
            spendCents: l.gastoCents,
            impressions: l.impressoes ?? null,
            clicks: l.cliques ?? null,
            platformConversions: l.conversoesPlataforma ?? null,
            platformRevenueCents: l.faturamentoPlataformaCents ?? null,
            campaignName: l.campaignName ?? null,
            adsetName: l.adsetName ?? null,
            adName: l.adName ?? null,
            syncedAt: new Date(),
          },
        });
      }

      await db.update(adAccounts)
        .set({ lastSyncedAt: new Date() })
        .where(eq(adAccounts.id, conta.id));

      resumos.push({
        conta: conta.label,
        plataforma: conta.platform,
        linhas: r.linhas.length,
        gastoTotalCents: r.linhas.reduce((s, l) => s + l.gastoCents, 0),
        moeda: r.moeda,
        avisos: r.avisos,
      });
    } catch (e) {
      resumos.push({
        conta: conta.label, plataforma: conta.platform, linhas: 0,
        gastoTotalCents: 0, moeda: "?", avisos: [],
        erro: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return resumos;
}
