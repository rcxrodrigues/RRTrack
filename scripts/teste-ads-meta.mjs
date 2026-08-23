/*
 * O adaptador de gasto da Meta, com a API simulada.
 *
 * Testa o que realmente quebra: centavos vindos como string, purchase contra
 * omni_purchase, paginação, moeda diferente de BRL e token expirado. Um token
 * real provaria a conexão; isto prova a interpretação, que é onde o erro
 * silencioso mora.
 *
 * Compilar antes:
 *   npx tsc src/ads/meta.ts src/ads/types.ts --outDir /tmp/adsbuild  *     --target ES2022 --module ESNext --moduleResolution bundler --skipLibCheck
 */
/* Simula a Marketing API e confere o que o adaptador faz com a resposta. */
const chamadas = [];
globalThis.fetch = async (url, init) => {
  chamadas.push(String(url));
  const u = String(url);

  if (u.includes("fields=currency")) {
    return { ok: true, json: async () => ({ currency: "BRL", timezone_name: "America/Sao_Paulo" }) };
  }

  /* Segunda página, para provar que ele pagina. */
  if (u.includes("__pagina2__")) {
    return { ok: true, json: async () => ({
      data: [{
        date_start: "2026-08-22", spend: "0.07",
        campaign_id: "C1", campaign_name: "Frio",
        adset_id: "S1", adset_name: "LAL 1%",
        ad_id: "A9", ad_name: "Video 09",
        impressions: "12", clicks: "1",
      }],
    }) };
  }

  return { ok: true, json: async () => ({
    data: [
      {
        date_start: "2026-08-22",
        spend: "1234.56", impressions: "48120", clicks: "913",
        campaign_id: "C1", campaign_name: "Frio",
        adset_id: "S1", adset_name: "LAL 1%",
        ad_id: "A1", ad_name: "Video 03",
        actions: [
          { action_type: "landing_page_view", value: "700" },
          { action_type: "purchase", value: "18" },
          { action_type: "omni_purchase", value: "21" },
        ],
        action_values: [
          { action_type: "purchase", value: "2640.90" },
          { action_type: "omni_purchase", value: "3100.00" },
        ],
      },
      {
        date_start: "2026-08-22", spend: "0.005",
        campaign_id: "C1", ad_id: "A2", ad_name: "Estatico",
      },
      /* Linha sem ad_id — a que duplicaria o gasto se entrasse. */
      { date_start: "2026-08-22", spend: "99.99", campaign_id: "C2" },
    ],
    paging: { next: "https://graph.facebook.com/__pagina2__" },
  }) };
};

const { metaAdsAdapter } = await import("/tmp/adsbuild/meta.js");

let f = 0;
const eq = (l, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) f++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${l}` + (ok ? "" : `  obtido ${JSON.stringify(g)}, esperado ${JSON.stringify(w)}`)); };

const r = await metaAdsAdapter.buscarGasto("1234567890", { accessToken: "tok" }, { de: "2026-08-16", ate: "2026-08-22" });

console.log("\n== requisição ==");
eq("prefixo act_ acrescentado", chamadas.some((c) => c.includes("act_1234567890")), true);
eq("grão de anúncio", chamadas.some((c) => c.includes("level=ad")), true);
eq("uma linha por dia", chamadas.some((c) => c.includes("time_increment=1")), true);
eq("paginou", chamadas.filter((c) => c.includes("insights") || c.includes("pagina2")).length >= 2, true);

console.log("\n== valores ==");
const a1 = r.linhas.find((l) => l.adId === "A1");
eq("1234.56 vira 123456 centavos", a1.gastoCents, 123456);
eq("impressões", a1.impressoes, 48120);
eq("cliques", a1.cliques, 913);
eq("nome do conjunto", a1.adsetName, "LAL 1%");

const a2 = r.linhas.find((l) => l.adId === "A2");
eq("meio centavo arredonda para 1", a2.gastoCents, 1);
eq("campos ausentes ficam indefinidos", a2.impressoes, undefined);

console.log("\n== conversões da plataforma ==");
eq("usa purchase, não omni_purchase", a1.conversoesPlataforma, 18);
eq("valor de purchase em centavos", a1.faturamentoPlataformaCents, 264090);
eq("ignora landing_page_view", a1.conversoesPlataforma !== 700, true);
eq("sem actions fica indefinido", a2.conversoesPlataforma, undefined);

console.log("\n== o que NÃO entra ==");
eq("linha sem ad_id ainda vem do parser", r.linhas.filter((l) => !l.adId).length, 1);
console.log("     (é a sincronização que a descarta, para não duplicar)");

console.log("\n== conta ==");
eq("moeda lida da conta", r.moeda, "BRL");
eq("fuso lido da conta", r.fuso, "America/Sao_Paulo");
eq("sem avisos quando tudo certo", r.avisos.length, 0);
eq("total de linhas (2 páginas)", r.linhas.length, 4);

console.log("\n== conta em outra moeda avisa ==");
globalThis.fetch = async (url) => {
  if (String(url).includes("fields=currency")) return { ok: true, json: async () => ({ currency: "USD" }) };
  return { ok: true, json: async () => ({ data: [] }) };
};
const r2 = await metaAdsAdapter.buscarGasto("act_9", { accessToken: "t" }, { de: "2026-08-01", ate: "2026-08-02" });
eq("avisa sobre moeda diferente", r2.avisos.some((a) => a.includes("USD")), true);
eq("avisa sobre período vazio", r2.avisos.some((a) => a.includes("nenhum gasto")), true);

console.log("\n== token expirado tem mensagem própria ==");
globalThis.fetch = async (url) => {
  if (String(url).includes("fields=currency")) return { ok: true, json: async () => ({ currency: "BRL" }) };
  return { ok: false, status: 400, text: async () => '{"error":{"code":190,"message":"expired"}}' };
};
try {
  await metaAdsAdapter.buscarGasto("act_9", { accessToken: "t" }, { de: "2026-08-01", ate: "2026-08-02" });
  eq("deveria ter lançado", false, true);
} catch (e) {
  eq("mensagem explica o que fazer", e.message.includes("Business Manager"), true);
}

console.log("\n== sem token nem tenta ==");
try {
  await metaAdsAdapter.buscarGasto("act_9", {}, { de: "2026-08-01", ate: "2026-08-02" });
  eq("deveria ter lançado", false, true);
} catch (e) { eq("erro claro", e.message.includes("sem token"), true); }

console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
process.exit(f === 0 ? 0 : 1);
