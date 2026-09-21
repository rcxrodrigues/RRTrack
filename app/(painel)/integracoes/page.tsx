import { and, desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db/index";
import { adAccounts, destinations, gatewayConnections, metaProfiles, sites } from "@/db/schema";
import { contexto } from "@/core/sessao";
import { lojaAtual } from "@/core/loja-atual";
import { listGateways } from "@/gateways/registry";
import { MODELOS } from "@/core/utm";
import { Integracoes } from "@/ui/integracoes";

export const dynamic = "force-dynamic";

export default async function PaginaIntegracoes() {
  const ctx = await contexto();
  if (!ctx) redirect("/entrar");

  const loja = await lojaAtual(ctx);
  if (!loja) {
    return (
      <div style={{ padding: 40, color: "var(--ink-fraco)" }}>
        Nenhuma loja cadastrada ainda.
      </div>
    );
  }

  /*
   * Tudo filtrado por loja. As credenciais vêm cifradas do banco e NÃO são
   * decifradas aqui: a tela mostra que existe token, nunca o token. Uma vez
   * gravado, um segredo não precisa voltar para o navegador nunca mais.
   */
  const [contas, conexoes, pixels, site, perfil] = await Promise.all([
    db.select().from(adAccounts).where(eq(adAccounts.tenantId, loja.id)),
    db.select().from(gatewayConnections).where(eq(gatewayConnections.tenantId, loja.id)),
    db.select().from(destinations).where(eq(destinations.tenantId, loja.id)),
    /*
     * TODOS os sites ativos, não `limit(1)`.
     *
     * A tela usa o primeiro, mas precisa SABER se há outros. Escolher um em
     * silêncio foi o que fez o painel da Transforlar mostrar o coletor de
     * `qa-trocado.exemplo.com` sem nada explicando — e a ordem alfabética,
     * que é o que torna a escolha estável, punha o site de teste na frente.
     */
    db.select().from(sites).where(and(eq(sites.tenantId, loja.id), eq(sites.active, true)))
      .orderBy(sites.domain),
    /*
     * Só o nome e o prazo: o token nunca sai do servidor.
     *
     * E o MAIS RECENTE — a mesma ordem de `perfilDaLoja`, que é quem escolhe o
     * token de verdade. Uma loja pode ter mais de um perfil conectado (o índice
     * único é por `fbUserId`), e sem a ordem esta tela mostrava o nome de um
     * enquanto o sistema usava o token de outro. Divergir daquela ordem é pior
     * que não mostrar nada.
     */
    db.select({ nome: metaProfiles.name, expiraEm: metaProfiles.tokenExpiresAt })
      .from(metaProfiles).where(eq(metaProfiles.tenantId, loja.id))
      .orderBy(desc(metaProfiles.connectedAt)).limit(1),
  ]);

  const base = process.env.RR_BASE ?? "https://rr-track.vercel.app";

  return (
    <Integracoes
      loja={loja}
      base={base}
      site={site[0] ? {
        dominio: site[0].domain,
        chave: site[0].publicKey,
        coletor: site[0].collectorHost,
        coletorVerificadoEm: site[0].collectorVerifiedAt?.toISOString() ?? null,
        config: site[0].config,
      } : null}
      /* Os OUTROS, para a tela poder avisar em vez de escolher calada. */
      outrosSites={site.slice(1).map((s) => s.domain)}
      contas={contas.map((c) => ({
        id: c.id, plataforma: c.platform, externalId: c.externalId,
        label: c.label, ativo: c.active,
        temCredencial: Object.keys(c.credentials ?? {}).length > 0,
        sincronizadoEm: c.lastSyncedAt?.toISOString() ?? null,
      }))}
      conexoes={conexoes.map((g) => ({
        id: g.id, gateway: g.gateway, label: g.label, ativo: g.active,
        segredo: g.webhookSecret,
        temCredencial: Object.keys(g.credentials ?? {}).length > 0,
        taxas: (g.fees ?? {}) as Record<string, unknown>,
      }))}
      pixels={pixels.map((p) => ({
        id: p.id, plataforma: p.platform, externalId: p.externalId,
        label: p.label, ativo: p.active,
        codigoTeste: p.testEventCode,
        eventos: Array.isArray((p.config as Record<string, unknown>)?.eventos)
          ? ((p.config as Record<string, unknown>).eventos as string[]) : null,
        textoBotao: ((p.config as Record<string, unknown>)?.textoBotaoCheckout as string) ?? null,
      }))}
      gatewaysDisponiveis={listGateways().map((g) => ({
        id: g.id, label: g.label, especie: g.especie,
        repasse: g.passthroughFields.join(", "),
        credenciais: (g.credenciais ?? []).map((c) => ({ ...c })),
      }))}
      modelosUtm={MODELOS}
      perfilMeta={perfil[0]
        ? { nome: perfil[0].nome, expiraEm: perfil[0].expiraEm?.toISOString() ?? null }
        : null}
    />
  );
}
