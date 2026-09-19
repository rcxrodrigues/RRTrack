/*
 * Um navegador de mentira, para rodar public/rr.js de verdade.
 *
 * POR QUE EXISTE. O rr.js é o único pedaço do sistema que roda fora daqui —
 * no site da loja, num navegador que a suíte não tem. Testá-lo por expressão
 * regular sobre o código-fonte prova que uma linha está escrita, não que ela
 * funciona; e já houve caso neste repositório de guarda que era cópia da
 * condição que deveria vigiar, e portanto não vigiava nada.
 *
 * Então em vez de imitar o script, monta-se o mínimo de DOM e roda-se O
 * ARQUIVO, o mesmo que a Vercel serve. O que ele fizer aqui é o que ele faz lá.
 *
 * Mora num arquivo próprio porque dois testes o usam — o produto lido da
 * página e o GA4 — e duas cópias de um DOM falso divergiriam exatamente como
 * as duas listas de sufixo público divergiram.
 */
const fs = require("node:fs");
const path = require("node:path");


const fonte = fs.readFileSync(path.join(__dirname, "..", "public", "rr.js"), "utf8");

/* Monta um DOM mínimo e roda o script dentro dele, como um navegador faria. */
function carregar({
  html = "", url = "https://loja.exemplo.com/products/x", globais = {},
  /*
   * Cookies que a página JÁ tem quando o script chega. É por aqui que se
   * simula um `_ga` deixado pelo gtag.js de uma visita anterior.
   */
  cookies = "",
}) {
  const metas = [];
  const scripts = [];
  /* O que o script INJETOU na página — gtag.js e fbevents.js saem por aqui. */
  const injetados = [];
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
    /*
     * Script injetado. O rr.js carrega o fbevents.js e o gtag.js assim —
     * `createElement("script")`, `.src = ...`, `insertBefore` antes do
     * primeiro <script> da página — e é só isso que o navegador precisa
     * oferecer para os dois entrarem.
     */
    createElement() {
      return {
        _attrs: {},
        setAttribute(n, v) { this._attrs[n] = String(v); },
        getAttribute(n) { return this._attrs[n] ?? null; },
      };
    },
    getElementsByTagName(tag) {
      if (String(tag).toLowerCase() !== "script") return [];
      return [{ parentNode: { insertBefore(no) { injetados.push(no); } } }];
    },
    addEventListener() {}, removeEventListener() {},
    readyState: "complete", referrer: "",
    /* Acumula o que o script grava, para o teste do dominio conferir. */
    _cookies: cookies,
    get cookie() { return this._cookies; },
    set cookie(v) { this._cookies += (this._cookies ? "; " : "") + v; },
    title: "", documentElement: {}, body: {},
  };

  const u = new URL(url);
  const enviados = [];
  const ouvintes = {};

  const loc = { href: url, search: u.search, pathname: u.pathname, hostname: u.hostname };

  /* Navegacao sem recarregar, como um tema com JavaScript faria. */
  const hist = {
    state: null,
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
    /* Registra o que o script postou, para o teste do carrinho conferir. */
    fetch: async (url, opcoes) => {
      janela.__posts.push({ url, corpo: opcoes && opcoes.body });
      return { ok: true };
    },
    sessionStorage: {
      _d: {},
      getItem(k) { return this._d[k] ?? null; },
      setItem(k, v) { this._d[k] = String(v); },
    },
    crypto: { getRandomValues: (a) => a.fill(7) },
    /* O que um navegador tem e o vm nao: o script le os dois ao montar evento. */
    screen: { width: 390, height: 844 },
    Blob,
    Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: "America/Sao_Paulo" }) }) },
    RRTrackConfig: { siteKey: "pk_teste", endpoint: "https://x/rr/collect" },
    ...globais,
  };
  janela.__posts = [];
  janela.window = janela;
  janela.self = janela;

  const vm = require("node:vm");
  const ctx = vm.createContext(janela);
  vm.runInContext(fonte, ctx);

  /*
   * `enviados` traz os Blobs crus que o sendBeacon recebeu. Quem quiser o
   * conteúdo lê com `await enviados[i].text()` — o Blob é do próprio Node, e
   * `corpoDoBeacon` abaixo faz isso de uma vez. Quem só quer saber QUANTOS
   * disparos houve conta o tamanho da lista, que é o que o teste de navegação
   * precisa.
   */
  return {
    rr: janela.rr, enviados, janela, loc, hist, ouvintes,
    posts: janela.__posts,
    /* Os <script> que o rr.js pendurou na página: gtag.js, fbevents.js. */
    injetados,
  };
}

/** O corpo de um beacon, já em objeto. */
async function corpoDoBeacon(blob) {
  return JSON.parse(await blob.text());
}

module.exports = { carregar, corpoDoBeacon };
