import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db/index";
import { adAccounts, destinations, gatewayConnections, sites } from "@/db/schema";
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
  const [contas, conexoes, pixels, site] = await Promise.all([
    db.select().from(adAccounts).where(eq(adAccounts.tenantId, loja.id)),
    db.select().from(gatewayConnections).where(eq(gatewayConnections.tenantId, loja.id)),
    db.select().from(destinations).where(eq(destinations.tenantId, loja.id)),
    db.select().from(sites).where(and(eq(sites.tenantId, loja.id), eq(sites.active, true))).limit(1),
  ]);

  const base = process.env.RR_BASE ?? "https://rr-track.vercel.app";

  return (
    <Integracoes
      loja={loja}
      base={base}
      site={site[0] ? { dominio: site[0].domain, chave: site[0].publicKey } : null}
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
        id: g.id, label: g.label,
        repasse: g.passthroughFields.join(", "),
      }))}
      modelosUtm={MODELOS}
    />
  );
}
