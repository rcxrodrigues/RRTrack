/*
 * A leitura das UTMs por plataforma. Cada uma usa os cinco campos numa ordem
 * diferente, e ler utm_medium como "meio" é o erro que faz o painel inteiro
 * mostrar número errado sem avisar.
 *
 * Roda pela suíte: `node scripts/testar.mjs` compila os módulos em _tmp antes.
 *
 * Apontava para um /tmp compilado à mão, e por isso ficou FORA da suíte por
 * tempo demais — teste que ninguém roda não protege nada.
 */
import { extrairEstrutura, detectarPlataforma, MODELOS } from "../_tmp/core/utm.js";
let f = 0;
const eq = (l, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) f++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${l}` + (ok ? "" : `\n         obtido:   ${JSON.stringify(g)}\n         esperado: ${JSON.stringify(w)}`)); };

console.log("\n== Meta ==");
const meta = extrairEstrutura({
  utmSource: "FB",
  utmCampaign: "Black Friday|120210000012345",
  utmMedium: "Lookalike 1%|120210000067890",
  utmContent: "Video 03 - antes e depois|120210000011111",
  utmTerm: "Instagram_Reels",
});
eq("id da campanha", meta.campaignId, "120210000012345");
eq("nome da campanha", meta.campaignName, "Black Friday");
eq("id do conjunto vem do utm_medium", meta.adsetId, "120210000067890");
eq("id do anuncio vem do utm_content", meta.adId, "120210000011111");
eq("posicionamento", meta.placement, "Instagram_Reels");

console.log("\n== nome com barra vertical dentro ==");
const barra = extrairEstrutura({ utmSource: "FB", utmCampaign: "Promo | Kit | Frio|120210000099999" });
eq("parte no ULTIMO separador", barra.campaignId, "120210000099999");
eq("nome inteiro preservado", barra.campaignName, "Promo | Kit | Frio");

console.log("\n== Google ==");
const g = extrairEstrutura({
  utmSource: "google",
  utmCampaign: "21458763012",
  utmMedium: "168923445",
  utmContent: "698745123698",
  utmTerm: "Search::carimbo delineador",
});
eq("campanha so id", g.campaignId, "21458763012");
eq("sem nome (o Google nao manda)", g.campaignName, undefined);
eq("grupo de anuncios", g.adsetId, "168923445");
eq("posicionamento antes do ::", g.placement, "Search");

console.log("\n== TikTok ==");
const t = extrairEstrutura({
  utmSource: "tiktok",
  utmCampaign: "UGC Setembro|1798234567890123",
  utmMedium: "Amplo 18-34|1798234567890456",
  utmContent: "UGC 12 unboxing|1798234567890789",
  utmTerm: "For You",
});
eq("campanha", t.campaignId, "1798234567890123");
eq("conjunto (AID)", t.adsetId, "1798234567890456");
eq("criativo (CID)", t.adId, "1798234567890789");

console.log("\n== deteccao de plataforma ==");
eq("FB", detectarPlataforma("FB"), "meta");
eq("facebook", detectarPlataforma("facebook"), "meta");
eq("ig", detectarPlataforma("instagram"), "meta");
eq("google", detectarPlataforma("google"), "google");
eq("tiktok", detectarPlataforma("tiktok"), "tiktok");
eq("organico vira desconhecida", detectarPlataforma("newsletter"), "desconhecida");
eq("vazio", detectarPlataforma(undefined), "desconhecida");

console.log("\n== origem nao paga nao inventa estrutura ==");
const org = extrairEstrutura({ utmSource: "newsletter", utmCampaign: "setembro", utmMedium: "email" });
eq("nada extraido", org, {});

console.log("\n== so numero sem separador vira id ==");
eq("id solto", extrairEstrutura({ utmSource: "FB", utmCampaign: "120210000012345" }).campaignId, "120210000012345");
eq("nome solto", extrairEstrutura({ utmSource: "FB", utmCampaign: "Black Friday" }).campaignName, "Black Friday");

console.log("\n== modelos de URL ==");
eq("meta tem ad.id", MODELOS.meta.modelo.includes("{{ad.id}}"), true);
eq("google tem lpurl", MODELOS.google.modelo.includes("{lpurl}"), true);
eq("tiktok tem CID", MODELOS.tiktok.modelo.includes("__CID__"), true);

console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
process.exit(f === 0 ? 0 : 1);
