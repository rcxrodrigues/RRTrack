/*
 * RRTrack — coletor de primeira parte.
 *
 * Substitui o container do GTM e o pixel da Meta no navegador. Responsabilidades:
 *
 *   1. capturar a origem do visitante na chegada e mantê-la por 90 dias
 *   2. gerar e manter clickId, external_id, _fbp e _fbc
 *   3. carimbar o clickId nos links de checkout, para ele voltar no webhook
 *   4. mandar eventos para o coletor
 *
 * Servido do mesmo domínio do site (primeira parte). Isso importa por dois
 * motivos: bloqueadores de anúncio derrubam requisição para domínio de
 * terceiro, e o Safari limita cookie de script de terceiro a 7 dias — ou 24h
 * quando o link tem parâmetro de rastreamento, que é exatamente o caso de
 * tráfego pago.
 */
(function (window, document) {
  "use strict";

  var COOKIE_DAYS = 90;
  var STORE = "_rr";
  var cfg = window.RRTrackConfig || {};
  var endpoint = cfg.endpoint || "/rr/collect";
  var siteKey = cfg.siteKey;

  if (!siteKey) {
    if (window.console) console.warn("[rrtrack] siteKey ausente; coleta desligada");
    return;
  }

  /* ------------------------------------------------------------ utilidades */

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function setCookie(name, value, days) {
    var d = new Date();
    d.setTime(d.getTime() + days * 864e5);
    /*
     * O domínio precisa ser o registrável, com ponto na frente, para o cookie
     * valer também num subdomínio de checkout. SameSite=Lax deixa o cookie
     * sobreviver ao retorno do gateway; Strict o esconderia justamente na
     * volta, que é quando ele é necessário.
     */
    var host = location.hostname.split(".").slice(-2).join(".");
    document.cookie = name + "=" + encodeURIComponent(value) +
      ";expires=" + d.toUTCString() + ";path=/;domain=." + host +
      ";SameSite=Lax" + (location.protocol === "https:" ? ";Secure" : "");
  }

  function getCookie(name) {
    var m = document.cookie.match("(^|;)\\s*" + name + "\\s*=\\s*([^;]+)");
    return m ? decodeURIComponent(m[2]) : null;
  }

  function load() {
    try { return JSON.parse(window.localStorage.getItem(STORE) || "{}"); }
    catch (e) { return {}; }
  }

  function save(state) {
    try { window.localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) {}
  }

  /* -------------------------------------------------------------- atribuição */

  var UTM = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "utm_id"];
  var CLICK_IDS = ["fbclid", "gclid", "gbraid", "wbraid", "ttclid", "msclkid",
                   "twclid", "epik", "li_fat_id", "kwai_click_id"];
  /* Repasse de afiliado — é por aqui que o clickId volta do gateway. */
  var PASSTHROUGH = ["src", "sck", "xcod"];

  var params = new URLSearchParams(location.search);
  var state = load();

  /*
   * Só sobrescreve a origem quando a visita atual traz origem própria.
   * Sem isso, uma volta do checkout ou um refresh limpo apagaria a campanha
   * que trouxe a pessoa, e a venda viraria tráfego direto.
   */
  var temOrigemNova = UTM.concat(CLICK_IDS).some(function (k) { return params.has(k); });

  if (temOrigemNova || !state.attribution) {
    var attr = temOrigemNova ? {} : (state.attribution || {});
    UTM.concat(CLICK_IDS, PASSTHROUGH).forEach(function (k) {
      var v = params.get(k);
      if (v) attr[k] = v;
    });
    if (!attr.landing_url) attr.landing_url = location.href;
    if (!attr.referrer && document.referrer) attr.referrer = document.referrer;
    attr.captured_at = Date.now();
    state.attribution = attr;
  }

  /* ------------------------------------------------------------ identidade */

  /* Chave de junção com o webhook. Nasce uma vez e não muda. */
  state.click_id = state.click_id || getCookie("_rr_cid") || uuid();
  setCookie("_rr_cid", state.click_id, COOKIE_DAYS);

  /* Identificador de primeira parte, enviado hasheado como external_id. */
  state.external_id = state.external_id || getCookie("_rr_eid") || uuid();
  setCookie("_rr_eid", state.external_id, COOKIE_DAYS);

  /*
   * _fbp — sem pixel da Meta, somos nós que criamos. O formato é exigência da
   * Meta: fb.<subdominio>.<criado_em_ms>.<aleatorio>. Valor fora do formato é
   * descartado pelo CAPI sem erro, e a correspondência simplesmente não sobe.
   */
  var fbp = getCookie("_fbp");
  if (!fbp) {
    fbp = "fb.1." + Date.now() + "." + Math.floor(Math.random() * 9e9 + 1e9);
    setCookie("_fbp", fbp, COOKIE_DAYS);
  }
  state.fbp = fbp;

  /*
   * _fbc — a chave mais valiosa que existe para tráfego pago. O timestamp tem
   * de ser o do clique no anúncio, não o do envio do evento: a Meta usa essa
   * diferença para julgar recência, e carimbar "agora" num clique de três dias
   * atrás piora a correspondência em vez de melhorar.
   */
  var fbclid = params.get("fbclid");
  if (fbclid) {
    state.fbc = "fb.1." + Date.now() + "." + fbclid;
    setCookie("_fbc", state.fbc, COOKIE_DAYS);
  } else {
    state.fbc = getCookie("_fbc") || state.fbc;
  }

  save(state);

  /* ---------------------------------------------------------------- envio */

  function send(name, params_, eventId) {
    var body = {
      site_key: siteKey,
      click_id: state.click_id,
      external_id: state.external_id,
      event: name,
      event_id: eventId || (name + "." + state.click_id + "." + Date.now()),
      attribution: state.attribution,
      fbp: state.fbp,
      fbc: state.fbc,
      page_url: location.href,
      referrer: document.referrer || undefined,
      screen: screen.width + "x" + screen.height,
      /* O servidor precisa do fuso para o corte do dia no painel. */
      tz_offset: new Date().getTimezoneOffset(),
      params: params_ || {},
      occurred_at: new Date().toISOString()
    };

    var json = JSON.stringify(body);

    /*
     * sendBeacon sobrevive à navegação — indispensável no clique do checkout,
     * onde a página é abandonada no mesmo instante. Onde não houver, fetch com
     * keepalive faz o mesmo papel.
     *
     * O tipo é text/plain, e isso é obrigatório, não preferência: o coletor
     * vive num subdomínio (t.loja.com.br) e a página noutro, então a requisição
     * é entre origens. application/json exigiria uma verificação prévia de CORS
     * que o sendBeacon não sabe fazer — a requisição não sairia. text/plain
     * está na lista de tipos isentos. O servidor lê o texto e converte.
     */
    if (navigator.sendBeacon) {
      var blob = new Blob([json], { type: "text/plain;charset=UTF-8" });
      if (navigator.sendBeacon(endpoint, blob)) return;
    }
    try {
      fetch(endpoint, {
        method: "POST", body: json, keepalive: true, mode: "cors",
        headers: { "content-type": "text/plain;charset=UTF-8" }
      });
    } catch (e) {}
  }

  /* ------------------------------------------------- carimbo nos checkouts */

  /*
   * O clickId precisa atravessar o domínio do gateway e voltar no webhook.
   * Cookie não faz isso — só o parâmetro na URL faz. `sck` é o campo de
   * repasse que os gateways brasileiros ecoam de volta sem alterar.
   */
  function decorate(url) {
    try {
      var u = new URL(url, location.href);
      var alvo = cfg.passthroughField || "sck";
      if (!u.searchParams.has(alvo)) u.searchParams.set(alvo, state.click_id);

      /* Leva também a origem, para o gateway registrar do lado dele. */
      var attr = state.attribution || {};
      UTM.forEach(function (k) {
        if (attr[k] && !u.searchParams.has(k)) u.searchParams.set(k, attr[k]);
      });
      return u.toString();
    } catch (e) { return url; }
  }

  function decorateAll() {
    var sel = cfg.checkoutSelector || "[data-checkout-link], a[href*='checkout']";
    var links = document.querySelectorAll(sel);
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (a.href && a.getAttribute("data-rr-done") !== "1") {
        a.href = decorate(a.href);
        a.setAttribute("data-rr-done", "1");
      }
    }
  }

  /* Links de checkout costumam ser recriados por JS depois do carregamento. */
  if (document.readyState !== "loading") decorateAll();
  document.addEventListener("DOMContentLoaded", decorateAll);
  if (window.MutationObserver) {
    new MutationObserver(decorateAll).observe(document.documentElement, {
      childList: true, subtree: true
    });
  }

  /* --------------------------------------------- eventos por atributo */

  /*
   * A maioria dos sites não quer escrever JavaScript para rastrear. Então o
   * snippet lê atributos do HTML:
   *
   *   <div data-rr-view='{"id":"1313","name":"Carimbo","price":89.90}'></div>
   *   <button data-rr-event="add_to_cart" data-rr-product='{"id":"1313","price":89.90}'>
   *
   * Quem preferir chamar na mão continua podendo — rr('track', ...) faz o
   * mesmo. Os dois caminhos existem porque loja em plataforma fechada muitas
   * vezes só deixa mexer no HTML.
   */

  function lerProduto(el, attr) {
    var bruto = el.getAttribute(attr);
    if (!bruto) return null;
    try {
      var p = JSON.parse(bruto);
      return p && p.id ? p : null;
    } catch (e) {
      /* Também aceita a forma curta "sku|preco", para quem não quer JSON. */
      var partes = bruto.split("|");
      if (!partes[0]) return null;
      return { id: partes[0].trim(), price: partes[1] ? parseFloat(partes[1]) : undefined };
    }
  }

  function paramsDe(produto) {
    if (!produto) return {};
    var preco = typeof produto.price === "number" ? produto.price : undefined;
    var qtd = produto.quantity || 1;
    var p = {
      items: [{
        item_id: String(produto.id),
        item_name: produto.name,
        price: preco,
        quantity: qtd
      }],
      currency: produto.currency || "BRL"
    };
    if (preco !== undefined) p.value = preco * qtd;
    return p;
  }

  /* Produto da página: dispara view_content uma vez, quando a página carrega. */
  function verProduto() {
    var el = document.querySelector("[data-rr-view]");
    if (!el || el.getAttribute("data-rr-visto") === "1") return;
    var produto = lerProduto(el, "data-rr-view");
    if (!produto) return;
    el.setAttribute("data-rr-visto", "1");
    send("view_content", paramsDe(produto));
  }

  /*
   * Cliques. Um só ouvinte na raiz, em vez de um por botão: o botão pode ser
   * criado depois pelo JavaScript da loja, e ouvinte na raiz pega os dois casos.
   */
  document.addEventListener("click", function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest("[data-rr-event]") : null;
    if (el) {
      var nome = el.getAttribute("data-rr-event");
      if (nome) send(nome, paramsDe(lerProduto(el, "data-rr-product")));
      return;
    }

    /*
     * Clique no checkout vira início de compra. É o evento de maior intenção
     * que o navegador ainda consegue ver — depois disso a pessoa está no
     * domínio do gateway, onde não temos alcance nenhum.
     */
    var sel = cfg.checkoutSelector || "[data-checkout-link], a[href*='checkout']";
    var link = ev.target && ev.target.closest ? ev.target.closest(sel) : null;
    if (link && link.getAttribute("data-rr-ic") !== "1") {
      link.setAttribute("data-rr-ic", "1");
      send("begin_checkout", paramsDe(lerProduto(link, "data-rr-product")));
    }
  }, true);

  /* ------------------------------------------------------------ interface */

  var api = {
    /* rr('track', 'add_to_cart', { value: 89.90, items: [...] }) */
    track: function (name, params_, eventId) { send(name, params_, eventId); },
    /* Atalhos, para quem prefere ler o código depois. */
    viewContent: function (produto) { send("view_content", paramsDe(produto)); },
    addToCart: function (produto) { send("add_to_cart", paramsDe(produto)); },
    beginCheckout: function (produto) { send("begin_checkout", paramsDe(produto)); },
    /* Exposto para quem precisa montar a URL do checkout na mão. */
    decorate: decorate,
    clickId: function () { return state.click_id; },
    context: function () { return JSON.parse(JSON.stringify(state)); }
  };

  /* Consome a fila do stub assíncrono, se o site usou um. */
  var fila = window.rr && window.rr.q ? window.rr.q : [];
  window.rr = function (cmd) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (api[cmd]) return api[cmd].apply(null, args);
  };
  for (var j = 0; j < fila.length; j++) window.rr.apply(null, fila[j]);

  send("page_view");

  if (document.readyState !== "loading") verProduto();
  document.addEventListener("DOMContentLoaded", verProduto);

  /* ------------------------------------------------- quem ainda está aqui */

  /*
   * Pulso: um aviso periódico de que a aba continua aberta.
   *
   * Sem ele, "visitantes agora" seria "quem carregou uma página no último
   * minuto" — alguém lendo a página de vendas por dez minutos sumiria da
   * contagem, e o número diria menos do que a realidade justamente quando há
   * gente prestando atenção.
   *
   * Três limites, para não virar tráfego à toa:
   *
   *   - só pulsa com a aba visível; aba de fundo não é visitante olhando;
   *   - para depois de meia hora sem nenhuma interação, porque aba esquecida
   *     aberta a noite inteira contaria como pessoa presente para sempre;
   *   - um minuto entre pulsos, que é a granularidade que a tela mostra.
   */
  var PULSO_MS = 60000;
  var OCIOSO_MS = 30 * 60000;
  var ultimaInteracao = Date.now();

  ["click", "keydown", "scroll", "mousemove", "touchstart"].forEach(function (evt) {
    document.addEventListener(evt, function () { ultimaInteracao = Date.now(); },
      { passive: true });
  });

  setInterval(function () {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - ultimaInteracao > OCIOSO_MS) return;
    send("ping");
  }, PULSO_MS);

  /*
   * Voltar para a aba conta como presença imediata, sem esperar o próximo
   * ciclo: quem alterna entre abas apareceria com até um minuto de atraso.
   */
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") {
      ultimaInteracao = Date.now();
      send("ping");
    }
  });
})(window, document);
