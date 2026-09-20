/*
 * O adaptador do GA4 pelo Measurement Protocol.
 *
 * Roda pela suíte: `node scripts/testar.mjs` compila os módulos em _tmp antes.
 *
 * O QUE ESTÁ EM JOGO. O GA4 tem duas portas — gtag.js no navegador e o
 * Measurement Protocol daqui — e elas NÃO se substituem. Mandar por aqui um
 * evento que o gtag já mandou faz o GA4 contar os dois: o relatório dobra, a
 * taxa de conversão cai pela metade, e não há erro nenhum para investigar.
 * Por isso a primeira coisa testada é o que o adaptador RECUSA a fazer.
 *
 * O `fetch` é falso porque `google-analytics.com` está fora do alcance da
 * suíte, e porque um teste que dependesse da rede não rodaria em clone novo.
 * O que ele prova é o PAYLOAD — que é onde moram os erros silenciosos do MP:
 * ele responde 204 para qualquer coisa, inclusive para credencial errada.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const { ga4Adapter } = await import("../_tmp/destinations/ga4.js");

let f = 0;
const eq = (l, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) f++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${l}` + (ok ? "" : `\n         obtido:   ${JSON.stringify(g)}\n         esperado: ${JSON.stringify(w)}`)); };

/* ------------------------------------------------- o fetch de mentira -- */

let ultima = null;
const original = globalThis.fetch;
function fingirFetch(resposta) {
  globalThis.fetch = async (url, opcoes) => {
    ultima = { url: String(url), corpo: JSON.parse(opcoes.body) };
    return resposta;
  };
}
const resposta204 = { ok: true, status: 204, json: async () => ({}) };

const CFG = {
  externalId: "G-ABC123XYZ",
  credentials: { apiSecret: "segredo-de-teste" },
};

const PEDIDO = {
  gatewayOrderId: "PED-9981",
  currency: "BRL",
  grossCents: 14900,
  items: [
    { sku: "CARIMBO-01", name: "Carimbo de Delineador", quantity: 2, unitPriceCents: 4950 },
    { sku: null, name: "Frete", quantity: 1, unitPriceCents: 5000 },
  ],
};

const ENTRADA = {
  event: "purchase",
  eventId: "pur.PED-9981",
  occurredAt: new Date(),
  order: PEDIDO,
  click: { clickId: "abc", gaClientId: "1234567890.1700000000", gaSessionId: "1700000000" },
};

/* ================================ o que ele RECUSA fazer ================ */

console.log("\n== só a COMPRA passa pelo Measurement Protocol ==");
/*
 * Esta é a asserção mais importante do arquivo. O resto do funil já vai por
 * gtag.js, do navegador; repetir aqui dobraria a contagem em silêncio.
 */
eq("aceita purchase", ga4Adapter.supports.includes("purchase"), true);
for (const e of ["page_view", "view_content", "add_to_cart", "initiate_checkout",
                 "add_payment_info", "lead", "subscribe"]) {
  eq(`RECUSA ${e} — esse é do gtag`, ga4Adapter.supports.includes(e), false);
}

console.log("\n== e recusa o que não dá para enviar honestamente ==");

fingirFetch(resposta204);
const semSegredo = await ga4Adapter.send(ENTRADA, { ...CFG, credentials: {} });
eq("sem api secret não tenta", semSegredo.ok, false);
eq("e não vale reenfileirar", semSegredo.retryable, false);

/*
 * client_id inventado criaria um usuário NOVO a cada compra: a taxa de
 * conversão iria ao teto e a origem do tráfego se perderia, porque quem tinha
 * a origem era a sessão do navegador. Recusar deixa o motivo na tela.
 */
const semCliente = await ga4Adapter.send({ ...ENTRADA, click: { clickId: "abc" } }, CFG);
eq("sem client_id não tenta", semCliente.ok, false);
eq("e diz por quê", semCliente.error.includes("_ga"), true);
eq("e não vale reenfileirar", semCliente.retryable, false);

/* ==================================== o payload que sai ================= */

console.log("\n== o payload da compra ==");

ultima = null;
const r = await ga4Adapter.send(ENTRADA, CFG);
eq("enviou", r.ok, true);

eq("vai para a coleta do MP", ultima.url.startsWith("https://www.google-analytics.com/mp/collect"), true);
eq("com o measurement id", ultima.url.includes("measurement_id=G-ABC123XYZ"), true);
eq("e o api secret", ultima.url.includes("api_secret=segredo-de-teste"), true);

const ev = ultima.corpo.events[0];
eq("client_id é o do cookie _ga", ultima.corpo.client_id, "1234567890.1700000000");
eq("nome do evento no dialeto do GA4", ev.name, "purchase");
eq("valor em reais, não centavos", ev.params.value, 149);
eq("moeda em maiúscula", ev.params.currency, "BRL");

/*
 * Sem transaction_id o GA4 não deduplica: uma reentrega do webhook vira
 * receita dobrada no relatório, e a nossa trava por índice único não ajuda
 * porque ela impede o disparo repetido, não o reprocessamento legítimo.
 */
eq("transaction_id, que é como o GA4 deduplica", ev.params.transaction_id, "PED-9981");

/*
 * Sem engagement_time_msec o evento CHEGA e não aparece no Realtime nem conta
 * para engajamento. A API responde 204 igual, então o sintoma é só o evento
 * não existir nos relatórios que a pessoa abre para conferir.
 */
eq("engagement_time_msec presente", ev.params.engagement_time_msec, "1");

eq("session_id quando conhecido", ev.params.session_id, "1700000000");

console.log("\n  -- itens --");
eq("um item, não dois", ev.params.items.length, 1);
eq("o sem SKU fica de fora", ev.params.items.every((i) => i.item_id), true);
eq("id do item", ev.params.items[0].item_id, "CARIMBO-01");
eq("nome do item", ev.params.items[0].item_name, "Carimbo de Delineador");
eq("quantidade", ev.params.items[0].quantity, 2);
eq("preço unitário em reais", ev.params.items[0].price, 49.5);

console.log("\n  -- sessão desconhecida --");
ultima = null;
await ga4Adapter.send(
  { ...ENTRADA, click: { clickId: "abc", gaClientId: "111.222" } }, CFG,
);
eq("session_id some em vez de virar inventado",
  "session_id" in ultima.corpo.events[0].params, false);
eq("mas o client_id continua", ultima.corpo.client_id, "111.222");

console.log("\n  -- chaves de correspondência --");
eq("com sessão, duas", r.matchKeys, ["client_id", "session_id"]);

/* ======================================= o teste de conexão ============ */

console.log("\n== 'Testar conexão' usa o endpoint de DEPURAÇÃO ==");
/*
 * A coleta normal devolve 204 para QUALQUER coisa, inclusive credencial
 * errada. Um teste contra ela diria "funcionou" com o api_secret trocado —
 * confiança falsa exatamente onde a pessoa foi buscar confiança.
 */
ultima = null;
globalThis.fetch = async (url, opcoes) => {
  ultima = { url: String(url), corpo: JSON.parse(opcoes.body) };
  return { ok: true, status: 200, json: async () => ({ validationMessages: [] }) };
};
const bom = await ga4Adapter.testar(CFG);
eq("vai para /debug/mp/collect", ultima.url.includes("/debug/mp/collect"), true);
eq("payload sem problema é aprovado", bom.ok, true);
eq("e diz que nada foi registrado", bom.detalhe.includes("nada foi registrado"), true);

globalThis.fetch = async () => ({
  ok: true, status: 200,
  json: async () => ({ validationMessages: [{ description: "measurement_id desconhecido" }] }),
});
const ruim = await ga4Adapter.testar(CFG);
eq("validationMessages REPROVA", ruim.ok, false);
eq("e mostra o que o Google disse", ruim.detalhe, "measurement_id desconhecido");

globalThis.fetch = original;

/* ================================= a outra metade: o gtag no navegador == */

/*
 * O adaptador acima é metade do GA4. A outra metade é o gtag.js, que o rr.js
 * carrega a partir da configuração — e as duas juntas só funcionam se NENHUM
 * evento sair pelas duas.
 *
 * Aqui não há navegador para rodar o rr.js, então o que se testa é o que dá
 * para testar de verdade: a TABELA de eventos, extraída do arquivo que vai
 * para produção. Não uma cópia — uma cópia que concorda consigo mesma não
 * prova nada, e este repositório já pagou por isso uma vez.
 */

const ler = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const rr = ler("public/rr.js");

console.log("\n== o mapa de eventos do gtag, lido de public/rr.js ==");

const GA4 = new Function("return {" + /var GA4 = \{([\s\S]*?)\n  \};/.exec(rr)[1] + "}")();

/*
 * ESTA É A ASSERÇÃO QUE IMPORTA. A compra sai pelo servidor, quando o gateway
 * confirma o pagamento. Se ela voltar para este mapa, o GA4 passa a contar as
 * duas: a receita dobra, a taxa de conversão cai pela metade, e não há erro
 * nenhum para investigar — só um número que parou de bater com a realidade.
 *
 * E pior que dobrar: a compra do navegador conta venda que o gateway ainda vai
 * recusar (pix não pago, cartão negado).
 */
eq("purchase NÃO vai pelo navegador", "purchase" in GA4, false);

/* E o adaptador do servidor é o dono dela, para não sobrar ninguém. */
eq("quem manda a compra é o servidor", ga4Adapter.supports, ["purchase"]);

console.log("\n  -- e o funil vai, no dialeto do GA4 --");
eq("page_view", GA4.page_view, "page_view");
/* O GA4 não conhece "view_content" — esse nome é da Meta. */
eq("view_content vira view_item", GA4.view_content, "view_item");
eq("add_to_cart", GA4.add_to_cart, "add_to_cart");
eq("begin_checkout", GA4.begin_checkout, "begin_checkout");
/* Nem "lead": no GA4 é generate_lead. */
eq("lead vira generate_lead", GA4.lead, "generate_lead");
/* O pulso é nosso, não é evento de análise nenhuma. */
eq("ping não existe para o GA4", "ping" in GA4, false);

console.log("\n  -- e o page_view não sai duas vezes --");
/*
 * O `config` do GA4 dispara um page_view sozinho. Como o rr.js também manda o
 * seu — inclusive na navegação por JavaScript, que o gtag não enxerga —
 * deixar o automático ligado daria dois por carregamento.
 */
eq("o config desliga o page_view automático",
  /send_page_view: false/.test(rr), true);

/* ============================ e agora rodando o rr.js DE VERDADE ======== */

/*
 * Tudo acima lê o arquivo. Daqui para baixo o arquivo RODA, dentro de um DOM
 * de mentira — o mesmo public/rr.js que a Vercel serve. Expressão regular
 * prova que a linha está escrita; só a execução prova que ela funciona.
 */

const { carregar, corpoDoBeacon } = createRequire(import.meta.url)("./dom-falso.cjs");

const CFG_BASE = { siteKey: "pk_teste", endpoint: "https://t.loja.com.br/rr/collect" };
/* Um `_ga` e um `_ga_<ID>` como o gtag.js os deixa. */
const COOKIES_GA = "_ga=GA1.1.1234567890.1700000000;"
  + " _ga_ABC123XYZ=GS1.1.1700000500.3.0.1700000505.0.0.0";

/** Os eventos que foram parar no dataLayer, já legíveis. */
function eventosNoDataLayer(janela) {
  return (janela.dataLayer ?? [])
    .map((a) => Array.from(a))
    .filter((a) => a[0] === "event")
    .map((a) => ({ nome: a[1], params: a[2] }));
}

console.log("\n== o rr.js carregando o gtag a partir da configuração ==");

const comGa4 = carregar({
  url: "https://loja.com.br/produto",
  cookies: COOKIES_GA,
  globais: { RRTrackConfig: { ...CFG_BASE, ga4: ["G-TESTE12345"] } },
});

const gtagJs = comGa4.injetados.find((s) => String(s.src).includes("googletagmanager"));
eq("injetou o gtag.js", !!gtagJs, true);
/* O id vem da CONFIGURAÇÃO, nunca escrito no código: uma oferta, uma propriedade. */
eq("com o measurement id da configuração",
  gtagJs && gtagJs.src, "https://www.googletagmanager.com/gtag/js?id=G-TESTE12345");
eq("assíncrono, para não segurar a página", gtagJs && gtagJs.async, true);

const camadas = (comGa4.janela.dataLayer ?? []).map((a) => Array.from(a));
const config = camadas.find((a) => a[0] === "config");
eq("configurou a propriedade", config && config[1], "G-TESTE12345");
/*
 * Sem isto o GA4 dispara um page_view sozinho no `config`, e o rr.js dispara
 * o dele logo abaixo: dois por carregamento, e um relatório que parece bom.
 */
eq("com o page_view automático DESLIGADO",
  config && config[2] && config[2].send_page_view, false);

console.log("\n  -- e mandando o funil, no dialeto do GA4 --");

const evs = () => eventosNoDataLayer(comGa4.janela);
eq("o page_view saiu uma vez", evs().filter((e) => e.nome === "page_view").length, 1);

comGa4.rr("viewContent", { id: "SKU-1", name: "Carimbo", price: 89.9 });
comGa4.rr("addToCart", { id: "SKU-1", name: "Carimbo", price: 89.9, quantity: 2 });
comGa4.rr("beginCheckout", { id: "SKU-1", price: 89.9 });
comGa4.rr("track", "lead");

eq("view_content virou view_item", evs().some((e) => e.nome === "view_item"), true);
eq("add_to_cart", evs().some((e) => e.nome === "add_to_cart"), true);
eq("begin_checkout", evs().some((e) => e.nome === "begin_checkout"), true);
eq("lead virou generate_lead", evs().some((e) => e.nome === "generate_lead"), true);
/* Nomes da Meta não podem vazar para o GA4: lá eles não existem. */
eq("e nenhum nome da Meta atravessou",
  evs().some((e) => e.nome === "view_content" || e.nome === "lead"), false);

const itemNoCarrinho = evs().find((e) => e.nome === "add_to_cart");
eq("os parâmetros já saem no formato do GA4",
  itemNoCarrinho.params.items[0].item_id, "SKU-1");
eq("com preço em reais", itemNoCarrinho.params.items[0].price, 89.9);
eq("e valor total", itemNoCarrinho.params.value, 179.8);

console.log("\n  -- e A COMPRA NÃO SAI DAQUI --");
/*
 * A asserção que protege o faturamento do relatório. A compra vai pelo
 * servidor, quando o gateway confirma o pagamento. Saindo também daqui, o GA4
 * conta as duas — e ainda conta venda que o gateway vai recusar.
 */
const antesDaCompra = evs().length;
comGa4.rr("track", "purchase", {
  value: 149, currency: "BRL", transaction_id: "PED-1",
  items: [{ item_id: "SKU-1", price: 149, quantity: 1 }],
});
eq("nada novo no dataLayer", evs().length, antesDaCompra);
eq("e purchase não está lá", evs().some((e) => e.nome === "purchase"), false);

console.log("\n  -- e o pulso também não vira evento de análise --");
eq("ping não vai para o GA4", evs().some((e) => e.nome === "ping"), false);

console.log("\n== quando a loja JÁ tem gtag, o rr.js sai da frente inteiro ==");
/*
 * Duas instalações de GA4 na mesma página contam tudo duas vezes, e o sintoma
 * é um relatório plausível: números maiores, nada quebrado.
 */
for (const [rotulo, jaTem] of [
  ["gtag do tema da loja", { gtag: () => {}, dataLayer: [] }],
  /* GTM: quem tem GTM quase sempre configura o GA4 por dentro dele. */
  ["só o dataLayer do GTM", { dataLayer: [] }],
]) {
  const j = carregar({
    url: "https://loja.com.br/produto",
    cookies: COOKIES_GA,
    globais: {
      RRTrackConfig: { ...CFG_BASE, ga4: ["G-TESTE12345"] },
      console: { warn() {} },
      ...jaTem,
    },
  });
  eq(`${rotulo}: não injeta um segundo gtag`,
    j.injetados.some((s) => String(s.src).includes("googletagmanager")), false);
  eq(`${rotulo}: e não manda evento nenhum`, eventosNoDataLayer(j.janela).length, 0);
}

console.log("\n  -- e sem GA4 configurado nada acontece --");
const semGa4 = carregar({
  url: "https://loja.com.br/produto",
  globais: { RRTrackConfig: { ...CFG_BASE } },
});
eq("nenhum script do Google", semGa4.injetados.length, 0);
eq("e nenhum dataLayer criado", semGa4.janela.dataLayer, undefined);

console.log("\n== o client_id atravessa do navegador até o servidor ==");

/* Primeiro no beacon de verdade, que é onde ele sai da página. */
const beacon = await corpoDoBeacon(comGa4.enviados[0]);
/*
 * O `_ga` é "GA1.1.1234567890.1700000000" e o client_id são os DOIS últimos
 * campos. Mandar o cookie inteiro não dá erro: o MP aceita qualquer string, e
 * o evento cai num usuário que não existe.
 */
eq("o client_id são os dois últimos campos do _ga",
  beacon.ga_client_id, "1234567890.1700000000");
/* O session_id é o TERCEIRO campo do _ga_<ID> — o início da sessão. */
eq("o session_id é o terceiro campo do _ga_<ID>", beacon.ga_session_id, "1700000500");

console.log("\n  -- e sem GA4 na página os dois vão vazios, que é o certo --");
const beaconSemGa = await corpoDoBeacon(semGa4.enviados[0]);
eq("sem client_id inventado", beaconSemGa.ga_client_id, undefined);
eq("sem session_id inventado", beaconSemGa.ga_session_id, undefined);

console.log("\n  -- e daí para o banco --");
/*
 * A corrente inteira, elo por elo. Faltando qualquer um, a compra chega ao GA4
 * sem `client_id`, o adaptador recusa (com razão), e a venda fica sem origem.
 */
const rota = ler("app/api/collect/route.ts");
const tsx = ler("src/ui/integracoes.tsx");

eq("o coletor grava o client_id", rota.includes("gaClientId: str(body.ga_client_id)"), true);
eq("e o session_id", rota.includes("gaSessionId: str(body.ga_session_id)"), true);
/*
 * COALESCE, e aqui ele vale mais do que nos outros campos: o gtag.js carrega
 * assíncrono, então o PRIMEIRO beacon sai sempre sem o `_ga`. Sem COALESCE,
 * qualquer beacon posterior (um pulso de aba parada) apagaria o valor que o
 * segundo tinha preenchido.
 */
eq("e não apaga o que já veio",
  rota.includes("COALESCE(EXCLUDED.ga_client_id"), true);
/*
 * E um pulso quando o cookie finalmente aparece — senão quem entra e compra
 * pelo mesmo caminho nunca teria o client_id gravado na sessão de clique.
 */
eq("o rr.js pulsa quando o _ga aparece",
  /if \(gaClientId\(\)\) \{ clearInterval\(t\); send\("ping"\); return; \}/.test(rr), true);
eq("e o pulso chega a gravar a sessão antes do 204",
  rota.indexOf("onConflictDoUpdate") < rota.indexOf('eventName === "ping"'), true);

console.log("\n== a configuração, e o que ela não deixa errar ==");

eq("o snippet leva os measurement ids", tsx.includes("cfg.push(`ga4:${JSON.stringify(ga4)}`)"), true);
/* Propriedade removida na tela tem de sumir do snippet junto. */
eq("só as propriedades ATIVAS",
  /p\.ativo && p\.plataforma === "ga4"/.test(tsx), true);
/*
 * O erro que a validação evita: colar o ID DO FLUXO, que é só número e fica na
 * mesma tela do Google. O Measurement Protocol responde 204 para id
 * inexistente — todo envio "dá certo" e nenhum evento aparece em lugar nenhum.
 */
eq("o ID de métrica é conferido ao gravar",
  ler("app/api/integracoes/route.ts").includes('/^G-[A-Z0-9]{4,}$/i'), true);
/* O api_secret é credencial: entra cifrado, como todas. */
eq("o api_secret entra pela lista de credenciais cifradas",
  /"conversionAction", "apiSecret"/.test(ler("app/api/integracoes/route.ts")), true);
eq("e o ga4 é destino aceito",
  ler("app/api/integracoes/route.ts").includes('["meta", "google", "tiktok", "ga4"]'), true);
/*
 * O GA4 não é plataforma de anúncio: não tem gasto, não tem conta, não tem
 * ROAS. Entrando em PLATAFORMAS, a aba de Anúncios pediria credencial de uma
 * API que não existe — um cartão para sempre vazio, que parece configuração
 * faltando.
 */
eq("e NÃO entra na lista de contas de anúncio",
  ler("app/api/integracoes/route.ts")
    .includes('const PLATAFORMAS_ANUNCIO = ["meta", "google", "tiktok"];'), true);

console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
process.exit(f === 0 ? 0 : 1);
