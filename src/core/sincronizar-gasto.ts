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

import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/index";
import { adAccounts, adSpendDaily, tenants } from "../db/schema";
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
  /** Pulou sem chamar ninguém, e por quê. */
  pulou?: string;
}

/*
 * Quanto tempo uma busca em andamento continua valendo como "em andamento".
 *
 * Se a função morrer no meio — tempo esgotado, deploy no meio do caminho — a
 * marca ficaria presa para sempre e a conta nunca mais sincronizaria. Cinco
 * minutos é folgado para a busca mais lenta e curto para destravar sozinho.
 */
const TRAVA_MIN = 5;

/*
 * Intervalo mínimo entre duas buscas da mesma conta, mesmo pedidas à mão.
 *
 * Existe porque o botão "Atualizar" convida a clicar de novo quando o número
 * não muda — e o número não muda porque a plataforma ainda não recalculou, não
 * porque a busca falhou. Clicar dez vezes só aproxima o bloqueio.
 */
const INTERVALO_MIN_SEG = 60;

/** AAAA-MM-DD de N dias atrás, em UTC. */
function diaUtc(deslocamento = 0): string {
  const d = new Date(Date.now() + deslocamento * 86400_000);
  return d.toISOString().slice(0, 10);
}

export async function sincronizarGasto(
  tenantId: string,
  opcoes: { dias?: number; plataforma?: string; forcar?: boolean } = {},
): Promise<ResumoSync[]> {
  const dias = Math.min(Math.max(opcoes.dias ?? 7, 1), 90);
  const janela = { de: diaUtc(-dias), ate: diaUtc(0) };

  const contas = await db.select().from(adAccounts).where(and(
    eq(adAccounts.tenantId, tenantId),
    eq(adAccounts.active, true),
    ...(opcoes.plataforma ? [eq(adAccounts.platform, opcoes.plataforma)] : []),
  ));

  /*
   * A moeda da loja, para comparar com a que cada conta reporta.
   *
   * A comparacao vive aqui e nao no adaptador porque o adaptador nao conhece
   * a loja: ele so sabe dizer em que moeda a conta reporta. Enquanto todas as
   * lojas eram brasileiras dava para escrever "BRL" na mao la dentro; com uma
   * loja em libra, aquilo alertava sobre a conta certa e calava sobre a errada.
   */
  const [loja] = await db.select({ moeda: tenants.currency })
    .from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const moedaDaLoja = loja?.moeda ?? "BRL";

  const resumos: ResumoSync[] = [];

  const agora = Date.now();

  for (const conta of contas) {
    /*
     * Três portas antes de tocar na API, na ordem em que importam.
     */

    /* 1. A plataforma bloqueou e disse até quando. Insistir aumenta a espera. */
    if (conta.blockedUntil && conta.blockedUntil.getTime() > agora) {
      const faltam = Math.ceil((conta.blockedUntil.getTime() - agora) / 60_000);
      resumos.push({
        conta: conta.label, plataforma: conta.platform, linhas: 0,
        gastoTotalCents: 0, moeda: "?", avisos: [],
        pulou: `bloqueada pela plataforma; libera em ${faltam} min`,
      });
      continue;
    }

    /* 2. Já há uma busca correndo. Duas abas abertas não podem virar duas buscas. */
    if (conta.syncingSince && agora - conta.syncingSince.getTime() < TRAVA_MIN * 60_000) {
      resumos.push({
        conta: conta.label, plataforma: conta.platform, linhas: 0,
        gastoTotalCents: 0, moeda: "?", avisos: [],
        pulou: "já há uma sincronização em andamento",
      });
      continue;
    }

    /* 3. Buscou agora há pouco. O número da plataforma nem mudou ainda. */
    if (!opcoes.forcar && conta.lastSyncedAt
        && agora - conta.lastSyncedAt.getTime() < INTERVALO_MIN_SEG * 1000) {
      resumos.push({
        conta: conta.label, plataforma: conta.platform, linhas: 0,
        gastoTotalCents: 0, moeda: "?", avisos: [],
        pulou: "sincronizada há menos de um minuto",
      });
      continue;
    }

    const adapter = getAdSpend(conta.platform);
    if (!adapter) {
      resumos.push({
        conta: conta.label, plataforma: conta.platform, linhas: 0,
        gastoTotalCents: 0, moeda: "?", avisos: [],
        erro: `sem adaptador de gasto para ${conta.platform}`,
      });
      continue;
    }

    /* Marca a trava ANTES de sair chamando, para outra aba enxergar. */
    await db.update(adAccounts)
      .set({ syncingSince: new Date() })
      .where(eq(adAccounts.id, conta.id));

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
          /* A moeda em que ESTA conta reporta — ver o comentario na coluna. */
          currency: r.moeda,
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
            /* A conta pode ter trocado de moeda; a ultima leitura e a boa. */
            currency: r.moeda,
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
        .set({
          lastSyncedAt: new Date(),
          syncingSince: null,
          usagePct: r.usoPct ?? null,
          blockedUntil: r.bloqueadoAte ?? null,
        })
        .where(eq(adAccounts.id, conta.id));

      resumos.push({
        conta: conta.label,
        plataforma: conta.platform,
        linhas: r.linhas.length,
        gastoTotalCents: r.linhas.reduce((s, l) => s + l.gastoCents, 0),
        moeda: r.moeda,
        avisos: r.moeda !== moedaDaLoja
          ? [...r.avisos,
             `esta conta reporta em ${r.moeda} e a loja e em ${moedaDaLoja}: ` +
             `o gasto fica gravado na moeda original e NAO entra nos totais`]
          : r.avisos,
      });
    } catch (e) {
      /*
       * Solta a trava mesmo em erro. Trava presa por causa de uma falha
       * transitória deixaria a conta sem sincronizar até alguém notar.
       */
      await db.update(adAccounts)
        .set({ syncingSince: null })
        .where(eq(adAccounts.id, conta.id));

      resumos.push({
        conta: conta.label, plataforma: conta.platform, linhas: 0,
        gastoTotalCents: 0, moeda: "?", avisos: [],
        erro: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return resumos;
}

/* ------------------------------------------------------- vale buscar? -- */

/*
 * Decide se a visita a uma tela deve mandar buscar gasto na plataforma.
 *
 * Mora aqui, e não em cada tela, porque a resposta tem DOIS motivos e esquecer
 * um deles produz número errado sem produzir erro:
 *
 *   1. o gasto está velho — a sincronização por obsolescência de sempre;
 *   2. a janela que a pessoa escolheu é maior do que a que já foi buscada.
 *
 * O segundo é o que passou despercebido por mais tempo. A consulta respeitava
 * o filtro de data, a busca era fixa em sete dias, e escolher "30 dias" mostrava
 * faturamento de trinta contra gasto de sete — ROAS quatro vezes maior, e
 * plausível o bastante para alguém decidir em cima.
 *
 * Devolve quantos dias buscar, ou `null` quando não há o que fazer.
 */
export async function precisaBuscarGasto(
  tenantId: string,
  janela: { de: string; dias: number; plataforma?: string },
): Promise<number | null> {
  const OBSOLETO_MIN = 10;

  const contas = await db.select({ sincronizadoEm: adAccounts.lastSyncedAt })
    .from(adAccounts)
    .where(and(
      eq(adAccounts.tenantId, tenantId),
      eq(adAccounts.active, true),
      ...(janela.plataforma ? [eq(adAccounts.platform, janela.plataforma)] : []),
    ));

  /* Sem conta conectada não há o que buscar, e insistir só gasta consulta. */
  if (contas.length === 0) return null;

  const velha = contas.some((c) =>
    !c.sincronizadoEm || Date.now() - c.sincronizadoEm.getTime() > OBSOLETO_MIN * 60_000);

  const [maisAntigo] = await db
    .select({ dia: adSpendDaily.date })
    .from(adSpendDaily)
    .where(and(
      eq(adSpendDaily.tenantId, tenantId),
      ...(janela.plataforma ? [eq(adSpendDaily.platform, janela.plataforma)] : []),
    ))
    .orderBy(asc(adSpendDaily.date))
    .limit(1);

  /*
   * Descoberto não é "velho": quem troca de 7 para 30 dias logo depois de
   * sincronizar tem o gasto fresco e a janela nova vazia do mesmo jeito.
   */
  const descoberto = !maisAntigo || maisAntigo.dia > janela.de;

  return velha || descoberto ? janela.dias : null;
}
