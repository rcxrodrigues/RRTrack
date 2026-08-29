/*
 * O produto lido da PÁGINA, sem configuração nenhuma.
 *
 * É o que faz uma loja com catálogo funcionar: dezenas de páginas, um script
 * só, e cada página se identifica sozinha. Sem isso, o lojista teria que gerar
 * um script por produto — que ninguém faz, então na prática a loja ficaria sem
 * `view_content` e sem valor nos eventos.
 *
 * O erro que este teste existe para pegar é o de CEM VEZES: o objeto da
 * Shopify traz preço em centavos e o JSON-LD traz em decimal. Confundir os
 * dois manda 8990 como valor de uma venda de R$ 89,90 — e a Meta passa a
 * otimizar para um retorno cem vezes maior que o real, sem erro nenhum.
 *
 *   node scripts/teste-produto-pagina.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

let f = 0;
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) f++;
  console.log(`  ${ok ? "ok  " : "FALHA"} | ${l}`
    + (ok ? "" : `  obtido ${JSON.stringify(got)}, esperado ${JSON.stringify(want)}`));
};

const fonte = fs.readFileSync(path.join(__dirname, "..", "public", "rr.js"), "utf8");

/* Monta um DOM mínimo e roda o script dentro dele, como um navegador faria. */
function carregar({ html = "", url = "https://loja.exemplo.com/products/x", globais = {} }) {
  const metas = [];
  const scripts = [];
  for (const m of html.matchAll(/<meta ([^>]+)>/g)) metas.push(m[1]);
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    scripts.push(m[1]);
  }

  const atributo = (bruto, nome) => {
    const m = new RegExp(`${nome}="([^"]*)"`).exec(bruto);
    return m ? m[1] : null;
  };

  const doc = {
    querySelector(sel) {
      let m = /^meta\[(property|name)="([^"]+)"\]$/.exec(sel);
      if (m) {
        const achou = metas.find((x) => atributo(x, m[1]) === m[2]);
        return achou ? { getAttribute: (n) => atributo(achou, n) } : null;
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel.includes("ld+json")) return scripts.map((t) => ({ textContent: t }));
      return [];
    },
    addEventListener() {}, removeEventListener() {},
    readyState: "complete", cookie: "", referrer: "",
    title: "", documentElement: {}, body: {},
  };

  const u = new URL(url);
  const enviados = [];
  const ouvintes = {};

  const loc = { href: url, search: u.search, pathname: u.pathname, hostname: u.hostname };

  /* Navegacao sem recarregar, como um tema com JavaScript faria. */
  const hist = {
    pushState(_e, _t, destino) {
      const d = new URL(destino, loc.href);
      loc.href = d.href; loc.pathname = d.pathname; loc.search = d.search;
    },
    replaceState(...a) { hist.pushState(...a); },
  };

  const janela = {
    document: doc,
    location: loc,
    history: hist,
    navigator: {
      userAgent: "node",
      sendBeacon: (_url, corpo) => {
        /* O script manda um Blob; aqui so precisamos do nome do evento. */
        enviados.push(corpo);
        return true;
      },
    },
    addEventListener(nome, fn) { (ouvintes[nome] = ouvintes[nome] || []).push(fn); },
    removeEventListener() {},
    setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent,
    /* Nao dispara de verdade: so precisa existir para o script terminar de carregar. */
    setInterval: () => 0, clearInterval: () => {},
    URL, URLSearchParams, JSON, Math, Date, parseFloat, parseInt, isFinite, String, Number,
    fetch: async () => ({ ok: true }),
    crypto: { getRandomValues: (a) => a.fill(7) },
    /* O que um navegador tem e o vm nao: o script le os dois ao montar evento. */
    screen: { width: 390, height: 844 },
    Blob,
    Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: "America/Sao_Paulo" }) }) },
    RRTrackConfig: { siteKey: "pk_teste", endpoint: "https://x/rr/collect" },
    ...globais,
  };
  janela.window = janela;
  janela.self = janela;

  const vm = require("node:vm");
  const ctx = vm.createContext(janela);
  vm.runInContext(fonte, ctx);

  /*
   * O corpo vai dentro de um Blob, que o vm nao sabe ler de volta. Em vez de
   * remontar isso, o teste conta OS DISPAROS e usa `rr('context')` para o
   * resto — o que importa aqui e quantas vezes cada navegacao dispara, nao o
   * conteudo, que os outros blocos ja cobrem.
   */
  return { rr: janela.rr, enviados, janela, loc, hist, ouvintes };
}

(async () => {
  console.log("\n== Shopify: preço vem em CENTAVOS no objeto dela ==");
  const { rr: rrShop } = carregar({
    url: "https://loja.exemplo.com/products/serum?variant=222",
    globais: {
      Shopify: { currency: { active: "BRL" } },
      ShopifyAnalytics: {
        meta: {
          product: {
            id: 111, title: "Sérum Facial",
            variants: [
              { id: 221, name: "Sérum Facial - 15ml", sku: "FLR-15", price: 4990 },
              { id: 222, name: "Sérum Facial - 30ml", sku: "FLR-30", price: 8990 },
            ],
          },
        },
      },
    },
  });
  const pShop = rrShop("product");
  eq("pega a variante da URL, não a primeira", pShop?.id, "FLR-30");
  eq("nome da variante", pShop?.name, "Sérum Facial - 30ml");
  eq("8990 centavos viram 89.90 reais", pShop?.price, 89.90);
  eq("moeda da loja", pShop?.currency, "BRL");

  console.log("\n== o identificador segue a MESMA ordem do pedido ==");
  /* sku, depois id da variante, depois id do produto — igual ao webhook.
     Se divergir, a Meta não casa ViewContent com Purchase. */
  const { rr: semSku } = carregar({
    url: "https://loja.exemplo.com/products/x?variant=222",
    globais: {
      ShopifyAnalytics: { meta: { product: { id: 111, title: "X",
        variants: [{ id: 222, name: "X", price: 1000 }] } } },
    },
  });
  eq("sem SKU, cai no id da variante", semSku("product")?.id, "222");

  console.log("\n== JSON-LD: aqui o preço é DECIMAL ==");
  const { rr: rrLd } = carregar({
    html: `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org", "@type": "Product",
      name: "Kit Completo", sku: "KIT-3",
      offers: { "@type": "Offer", price: "197.00", priceCurrency: "BRL" },
    })}</script>`,
  });
  const pLd = rrLd("product");
  eq("sku", pLd?.id, "KIT-3");
  eq('"197.00" continua 197, não 19700', pLd?.price, 197);
  eq("moeda", pLd?.currency, "BRL");

  console.log("\n== JSON-LD dentro de @graph, como muitos temas emitem ==");
  const { rr: rrGraph } = carregar({
    html: `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: "Loja" },
        { "@type": "Product", name: "Item", sku: "SKU-9",
          offers: { price: 49.9, priceCurrency: "BRL" } },
      ],
    })}</script>`,
  });
  eq("acha o produto dentro do @graph", rrGraph("product")?.id, "SKU-9");

  console.log("\n== Open Graph, o mínimo que quase todo site tem ==");
  const { rr: rrOg } = carregar({
    html: `<meta property="og:title" content="Camiseta Preta">
           <meta property="product:retailer_item_id" content="CAM-P">
           <meta property="product:price:amount" content="79.90">
           <meta property="product:price:currency" content="BRL">`,
  });
  const pOg = rrOg("product");
  eq("id do varejista", pOg?.id, "CAM-P");
  eq("nome", pOg?.name, "Camiseta Preta");
  eq("preço", pOg?.price, 79.90);

  console.log("\n== página que NÃO é de produto ==");
  /* Coleção, home e carrinho não publicam produto. Inventar um ali encheria o
     funil de view_content falso e estragaria a taxa de conversão da tela. */
  const { rr: rrNada } = carregar({ url: "https://loja.exemplo.com/collections/tudo" });
  eq("não inventa produto", rrNada("product"), null);

  console.log("\n== a configuração vence a página ==");
  const { rr: rrCfg } = carregar({
    globais: {
      RRTrackConfig: {
        siteKey: "pk_teste", endpoint: "https://x/rr/collect",
        product: { id: "MANUAL", name: "Escrito à mão", price: 10 },
      },
      ShopifyAnalytics: { meta: { product: { id: 1, title: "Da página",
        variants: [{ id: 2, sku: "DA-PAGINA", price: 500 }] } } },
    },
  });
  eq("quem escreveu foi explícito", rrCfg("product")?.id, "MANUAL");

  console.log("\n== navegacao sem recarregar a pagina ==");

  /*
   * Tema que troca o conteudo por JavaScript roda o script UMA vez. Sem
   * tratar isso, a pessoa visita seis produtos e a Meta ve um PageView e um
   * ViewContent — some dado, e some calado.
   *
   * O contrario tambem e erro: disparar em mudanca de QUERY inflaria o
   * page_view a cada clique num filtro de colecao. Numero inflado e pior que
   * numero faltando, porque ninguem desconfia de um numero grande.
   */
  const nav = carregar({ url: "https://loja.exemplo.com/collections/tudo" });
  const antes = nav.enviados.length;
  eq("carregar a pagina ja dispara um evento", antes >= 1, true);

  /* Filtro de colecao: muda so a query. */
  nav.hist.pushState({}, "", "/collections/tudo?filtro=preto");
  await new Promise((r) => setTimeout(r, 30));
  eq("mudar so a query nao dispara nada", nav.enviados.length, antes);

  /* Agora sim, outra pagina. */
  nav.hist.pushState({}, "", "/products/serum");
  await new Promise((r) => setTimeout(r, 30));
  eq("caminho novo dispara", nav.enviados.length > antes, true);

  const depoisDoProduto = nav.enviados.length;

  /* Voltar no navegador tambem e pagina nova. */
  nav.loc.pathname = "/collections/tudo";
  nav.loc.search = "";
  (nav.ouvintes.popstate || []).forEach((fn) => fn());
  await new Promise((r) => setTimeout(r, 30));
  eq("voltar tambem dispara", nav.enviados.length > depoisDoProduto, true);

  /* E a mesma pagina duas vezes nao dispara duas. */
  const estavel = nav.enviados.length;
  nav.hist.pushState({}, "", "/collections/tudo");
  await new Promise((r) => setTimeout(r, 30));
  eq("mesmo caminho de novo nao dispara", nav.enviados.length, estavel);


  console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
  process.exit(f === 0 ? 0 : 1);
})();
