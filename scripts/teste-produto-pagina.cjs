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
  const janela = {
    document: doc,
    location: { href: url, search: u.search, pathname: u.pathname, hostname: u.hostname },
    navigator: { userAgent: "node", sendBeacon: () => true },
    addEventListener() {}, removeEventListener() {},
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
  return janela.rr;
}

(async () => {
  console.log("\n== Shopify: preço vem em CENTAVOS no objeto dela ==");
  const rrShop = carregar({
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
  const semSku = carregar({
    url: "https://loja.exemplo.com/products/x?variant=222",
    globais: {
      ShopifyAnalytics: { meta: { product: { id: 111, title: "X",
        variants: [{ id: 222, name: "X", price: 1000 }] } } },
    },
  });
  eq("sem SKU, cai no id da variante", semSku("product")?.id, "222");

  console.log("\n== JSON-LD: aqui o preço é DECIMAL ==");
  const rrLd = carregar({
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
  const rrGraph = carregar({
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
  const rrOg = carregar({
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
  const rrNada = carregar({ url: "https://loja.exemplo.com/collections/tudo" });
  eq("não inventa produto", rrNada("product"), null);

  console.log("\n== a configuração vence a página ==");
  const rrCfg = carregar({
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

  console.log("\n" + (f === 0 ? "TODOS OS TESTES PASSARAM" : f + " FALHA(S)") + "\n");
  process.exit(f === 0 ? 0 : 1);
})();
