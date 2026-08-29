/*
 * RRTrack — coletor de primeira parte.
 *
 * Substitui o container do GTM e o código do pixel da Meta no <head> da loja.
 * Responsabilidades:
 *
 *   1. capturar a origem do visitante na chegada e mantê-la por 90 dias
 *   2. gerar e manter clickId, external_id, _fbp e _fbc
 *   3. carimbar o clickId nos links de checkout, para ele voltar no webhook
 *   4. mandar eventos para o coletor E para o pixel, com o MESMO event_id
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

  /*
   * Chave de junção com o webhook. Nasce uma vez e não muda.
   *
   * `cfg.clickId` vem na frente e é usado só pelo nosso checkout próprio, que
   * recebe o clickId na URL (o `sck` que o `decorate` carimbou no link). Sem
   * isso, o checkout hospedado noutro domínio não enxergaria o cookie do site
   * e abriria uma sessão nova — a venda ficaria atribuída ao clique na própria
   * página de pagamento, e não ao anúncio que trouxe a pessoa. No site do
   * lojista `cfg.clickId` não existe, e nada muda.
   */
  state.click_id = cfg.clickId || state.click_id || getCookie("_rr_cid") || uuid();
  setCookie("_rr_cid", state.click_id, COOKIE_DAYS);

  /* Identificador de primeira parte, enviado hasheado como external_id. */
  state.external_id = state.external_id || getCookie("_rr_eid") || uuid();
  setCookie("_rr_eid", state.external_id, COOKIE_DAYS);

  /*
   * _fbp — criado aqui, antes de o fbevents.js chegar. Quando o pixel carrega
   * ele encontra o cookie pronto e o reaproveita, então os dois lados falam do
   * mesmo navegador. O formato é exigência da Meta:
   * fb.<subdominio>.<criado_em_ms>.<aleatorio>. Valor fora do formato é
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

  /* ------------------------------------------------------- pixel da Meta */

  /*
   * O pixel do navegador é disparado AQUI, e não por código na página.
   *
   * Enquanto existirem dois lugares gerando `event_id` — um no pixel colado no
   * <head> e outro aqui — sempre haverá uma configuração em que eles divergem,
   * e a Meta conta a mesma conversão duas vezes sem acusar erro em lugar
   * nenhum. Com um gerador só, a deduplicação deixa de ser algo que se
   * configura e passa a ser algo que não tem como quebrar.
   *
   * Os dois lados continuam existindo, e isso não é redundância: o navegador
   * carrega sinais que o servidor não tem, e o servidor entrega os 20% a 30%
   * que bloqueador e ITP matam. O `event_id` compartilhado é o que faz a Meta
   * unir os dois em uma conversão só.
   */

  var META = {
    page_view: "PageView",
    view_content: "ViewContent",
    add_to_cart: "AddToCart",
    begin_checkout: "InitiateCheckout",
    purchase: "Purchase",
    lead: "Lead"
  };

  var pixels = Array.isArray(cfg.pixels) ? cfg.pixels : (cfg.pixel ? [cfg.pixel] : []);

  if (pixels.length && !window.fbq) {
    /* Stub oficial da Meta: enfileira chamadas até o fbevents.js chegar. */
    var n = window.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    };
    if (!window._fbq) window._fbq = n;
    n.push = n; n.loaded = true; n.version = "2.0"; n.queue = [];

    var t = document.createElement("script");
    t.async = true;
    t.src = "https://connect.facebook.net/en_US/fbevents.js";
    var primeiro = document.getElementsByTagName("script")[0];
    primeiro.parentNode.insertBefore(t, primeiro);
  }

  /*
   * O external_id vai na inicialização, como correspondência avançada.
   *
   * É a única chave de identidade que existe antes de a pessoa se identificar,
   * e mandá-la aqui faz o evento do navegador chegar com a MESMA chave que o
   * servidor manda — o que ajuda a Meta a costurar as duas metades mesmo
   * quando a deduplicação por event_id falha.
   */
  pixels.forEach(function (id) {
    try { window.fbq("init", String(id), { external_id: state.external_id }); } catch (e) {}
  });

  function paraMeta(params_) {
    var p = params_ || {};
    var itens = p.items || [];
    var saida = {};

    if (itens.length) {
      saida.content_ids = itens.map(function (i) { return String(i.item_id); });
      saida.content_type = "product";
      saida.contents = itens.map(function (i) {
        return { id: String(i.item_id), quantity: i.quantity || 1, item_price: i.price };
      });
      if (itens[0].item_name) saida.content_name = itens[0].item_name;
      saida.num_items = itens.reduce(function (t2, i) { return t2 + (i.quantity || 1); }, 0);
    }
    if (typeof p.value === "number") saida.value = p.value;
    if (p.currency) saida.currency = p.currency;
    if (p.transaction_id) saida.order_id = String(p.transaction_id);

    return saida;
  }

  function aoPixel(name, params_, eventId) {
    if (!pixels.length || !window.fbq) return;
    var nome = META[name];
    try {
      /*
       * Evento fora da lista padrão da Meta vai como personalizado. Mandá-lo
       * como padrão faria a Meta descartar em silêncio — e o lojista veria
       * um evento a menos sem nada explicando o sumiço.
       */
      window.fbq(nome ? "track" : "trackCustom", nome || name, paraMeta(params_), { eventID: eventId });
    } catch (e) {}
  }

  /* ---------------------------------------------------------------- envio */

  function send(name, params_, eventId) {
    /*
     * O id nasce aqui e serve aos dois lados. Era este o ponto: um gerador só.
     */
    var id = eventId || (name + "." + state.click_id + "." + Date.now());

    aoPixel(name, params_, id);

    var body = {
      site_key: siteKey,
      click_id: state.click_id,
      external_id: state.external_id,
      event: name,
      event_id: id,
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

  /*
   * O produto da página, quando o site tem um só.
   *
   * Oferta de resposta direta quase sempre vende uma coisa numa página só, e
   * escrever `data-rr-view` em cada botão é trabalho repetido. Declarado uma
   * vez na configuração, ele vale para todos os eventos que não trouxerem
   * produto próprio — e é o que faz `add_to_cart` e `begin_checkout` levarem
   * valor. Sem valor, a Meta não consegue otimizar por retorno, só por volume.
   */
  /*
   * Começa com o que veio na configuração e MUDA quando a página avisa.
   *
   * A configuração é estática, escrita no <head>, e por isso não acompanha
   * escolha de variante: numa oferta com cor, o comprador troca de Preto para
   * Marrom e o identificador continuaria o do carregamento. Aí o `add_to_cart`
   * sai com o SKU errado, e cruzar o dado do painel com o do GA4 depois vira
   * adivinhação.
   *
   * `rr('setProduct', {...})` troca isto a qualquer momento. Só muda o padrão —
   * botão com `data-rr-product` continua tendo a palavra final, porque quem
   * marcou aquele botão foi mais específico de propósito.
   */
  var produtoAtual = cfg.product && cfg.product.id ? cfg.product : null;

  function produtoPadrao() {
    return produtoAtual;
  }

  function paramsDe(produto) {
    produto = produto || produtoPadrao();
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

  /*
   * Produto da página: dispara view_content uma vez, quando a página carrega.
   *
   * Dois caminhos. O normal é achar `data-rr-view` no HTML — serve para loja
   * com catálogo, onde só ALGUMAS páginas são de produto.
   *
   * O segundo é `cfg.viewContentOnLoad`, para quando a página que a pessoa
   * abre JÁ É a página do produto. Aí "viu o produto" e "visitou o site" são o
   * mesmo acontecimento, e exigir um atributo no HTML só produziria uma etapa
   * do funil eternamente zerada. Continua valendo a pena disparar mesmo sendo
   * igual ao page_view: é o ViewContent que a Meta usa para montar público e
   * para casar a conversão depois.
   */
  var jaViu = false;

  function verProduto() {
    if (jaViu) return;

    var el = document.querySelector("[data-rr-view]");
    if (el && el.getAttribute("data-rr-visto") !== "1") {
      var produto = lerProduto(el, "data-rr-view");
      if (produto) {
        el.setAttribute("data-rr-visto", "1");
        jaViu = true;
        send("view_content", paramsDe(produto));
        return;
      }
    }

    if (cfg.viewContentOnLoad) {
      jaViu = true;
      send("view_content", paramsDe(null));
    }
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
     * Adicionar ao carrinho, sem precisar marcar o HTML.
     *
     * `data-rr-event` acima é o caminho explícito, e continua valendo. Só que
     * a loja já costuma ter um atributo dizendo exatamente isso — `data-add-to-cart`
     * é a convenção mais comum — e pedir para o lojista marcar de novo o mesmo
     * botão é trabalho sem ganho, além de uma etapa a mais para esquecer.
     *
     * Aqui NÃO há trava de disparo único, ao contrário do checkout: quem
     * adiciona duas vezes adicionou duas vezes, e é isso que a plataforma de
     * anúncio precisa ouvir. O funil conta sessões distintas, então repetir não
     * distorce a taxa de passagem.
     */
    var selCarrinho = cfg.addToCartSelector || "[data-add-to-cart], [data-rr-add-to-cart]";
    var botao = ev.target && ev.target.closest ? ev.target.closest(selCarrinho) : null;
    if (botao) {
      send("add_to_cart", paramsDe(lerProduto(botao, "data-rr-product")));
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
    /*
     * rr('setProduct', { id: '1414', name: 'Carimbo Marrom', price: 29.90 })
     *
     * Para página com variante: chame na troca de cor, tamanho ou plano. Os
     * eventos seguintes saem com este produto. Passar nada volta ao que estava
     * na configuração.
     */
    setProduct: function (produto) {
      produtoAtual = produto && produto.id
        ? produto
        : (cfg.product && cfg.product.id ? cfg.product : null);
      return produtoAtual;
    },
    /* O que os eventos estão levando agora — útil para conferir no console. */
    product: function () { return produtoAtual; },
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
