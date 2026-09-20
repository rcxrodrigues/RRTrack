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

  /*
   * O domínio em que o cookie vale, e o motivo de não serem "os dois últimos".
   *
   * Pegar os dois últimos rótulos funciona em `transforlar.com`, e QUEBRA em
   * `loja.com.br` — daria `com.br`, que é sufixo público. O navegador recusa
   * cookie de sufixo público sem dizer nada: o `_rr_cid` não grava, cada página
   * vira uma sessão nova, e o funil mostra visitante que nunca avança.
   *
   * Silencioso e no mercado principal: `.com.br` é o domínio da maioria das
   * lojas brasileiras, e `.co.uk` seria o mesmo problema na operação inglesa.
   *
   * A lista cobre os compostos que aparecem de verdade. A lista completa de
   * sufixos públicos tem milhares de entradas e é atualizada toda semana —
   * carregá-la num script de rastreamento custaria mais do que resolve.
   */
  var COMPOSTOS = [
    "com.br", "net.br", "org.br", "com.pt",
    "co.uk", "org.uk", "me.uk", "ac.uk",
    "com.au", "net.au", "org.au",
    "co.jp", "co.nz", "co.za", "co.in", "com.mx", "com.ar", "com.co",
  ];

  function dominioRegistravel(hostname) {
    var partes = hostname.split(".");
    if (partes.length < 3) return hostname;

    var doisUltimos = partes.slice(-2).join(".");
    /* Sufixo composto pede três rótulos: loja.com.br, e não com.br. */
    if (COMPOSTOS.indexOf(doisUltimos) !== -1) return partes.slice(-3).join(".");
    return doisUltimos;
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
    var host = dominioRegistravel(location.hostname);
    document.cookie = name + "=" + encodeURIComponent(value) +
      ";expires=" + d.toUTCString() + ";path=/;domain=." + host +
      ";SameSite=Lax" + (location.protocol === "https:" ? ";Secure" : "");
  }

  function getCookie(name) {
    var m = document.cookie.match("(^|;)\\s*" + name + "\\s*=\\s*([^;]+)");
    return m ? decodeURIComponent(m[2]) : null;
  }

  /*
   * O coletor está no mesmo site que esta página?
   *
   * Disso depende QUEM escreve o cookie do clickId, e a diferença vale 89 dias.
   *
   * Cookie escrito por JavaScript o Safari corta em 7 dias — ou em 24 HORAS
   * quando a pessoa chegou por link com parâmetro de rastreamento, que é todo
   * tráfego pago com `?fbclid=`. Cookie que chega por `Set-Cookie` numa
   * resposta do mesmo site não é cortado.
   *
   * Então, quando o coletor é do mesmo site, quem manda o cookie é ele, e este
   * script SAI DA FRENTE: reescrevê-lo aqui a cada página trocaria o cookie de
   * 90 dias do servidor por um de 24 horas, desfazendo em silêncio justamente
   * o que a configuração do subdomínio foi feita para resolver.
   *
   * Sem subdomínio, nada muda: o script continua escrevendo, como sempre.
   */
  var coletorMesmoSite = (function () {
    try {
      /* Endpoint relativo é o mesmo site por definição. */
      if (endpoint.indexOf("http") !== 0) return true;
      var alvo = document.createElement("a");
      alvo.href = endpoint;
      return dominioRegistravel(alvo.hostname) === dominioRegistravel(location.hostname);
    } catch (e) { return false; }
  })();

  /*
   * O `client_id` do GA4, extraído do cookie `_ga`.
   *
   * Formato: "GA1.1.1234567890.1700000000". O client_id são os DOIS últimos
   * campos juntos ("1234567890.1700000000") — não o cookie inteiro, e não só
   * o primeiro número. Mandar o formato errado não dá erro: o Measurement
   * Protocol aceita qualquer string como client_id, e o evento simplesmente
   * cai num usuário que não existe.
   *
   * O "GA1.1" da frente é versão e número de partes do domínio, e varia: num
   * subdomínio o segundo número é outro. Por isso pega-se do fim, não do
   * começo.
   */
  function gaClientId() {
    var v = getCookie("_ga");
    if (!v) return undefined;
    var p = v.split(".");
    return p.length >= 4 ? p.slice(-2).join(".") : undefined;
  }

  /*
   * O `session_id`, do cookie por propriedade `_ga_<ID>`.
   *
   * Formato: "GS1.1.1700000000.1.0.1700000005.0.0.0". O session_id é o
   * TERCEIRO campo — o carimbo de início da sessão.
   *
   * O nome do cookie carrega o measurement id, que não conhecemos aqui: o
   * snippet não recebe o do GA4. Então procura-se por prefixo. Havendo mais de
   * um (site com duas propriedades), pega-se o primeiro: a compra vai para uma
   * propriedade só, e qualquer uma das sessões é da mesma pessoa.
   */
  function gaSessionId() {
    var m = document.cookie.match(/(?:^|;)\s*_ga_[A-Z0-9]+\s*=\s*([^;]+)/);
    if (!m) return undefined;
    var p = decodeURIComponent(m[1]).split(".");
    return p.length >= 3 ? p[2] : undefined;
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
  var cidNoCookie = getCookie("_rr_cid");
  state.click_id = cfg.clickId || state.click_id || cidNoCookie || uuid();

  /*
   * Escreve só quando ainda NÃO existe cookie, ou quando o servidor não vai
   * escrever por nós.
   *
   * A primeira visita precisa do cookie na hora: se a requisição ao coletor
   * falhar por rede, a próxima página geraria outro clickId e a sessão
   * rachava em duas. Da segunda em diante, com coletor do mesmo site, o
   * `Set-Cookie` da resposta já renovou o prazo, e reescrever aqui só faria
   * o Safari cortá-lo de volta para 24 h.
   */
  if (!cidNoCookie || !coletorMesmoSite) {
    setCookie("_rr_cid", state.click_id, COOKIE_DAYS);
  }

  /*
   * Identificador de primeira parte, enviado hasheado como external_id.
   *
   * Mesma regra do clickId acima, e pelo mesmo motivo: com coletor do mesmo
   * site, quem renova é o `Set-Cookie` da resposta. Reescrever aqui a cada
   * página faria o Safari cortá-lo para 24 h — e external_id que renasce todo
   * dia faz a Meta ver uma pessoa nova por dia, derrubando a correspondência.
   */
  var eidNoCookie = getCookie("_rr_eid");
  state.external_id = state.external_id || eidNoCookie || uuid();
  if (!eidNoCookie || !coletorMesmoSite) {
    setCookie("_rr_eid", state.external_id, COOKIE_DAYS);
  }

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

  /* ------------------------------------------------------- GA4 (gtag.js) */

  /*
   * O GA4 do navegador, carregado A PARTIR DA CONFIGURAÇÃO.
   *
   * O measurement id vem da linha de `destinations` (plataforma "ga4"), sai no
   * snippet e chega aqui. Nunca escrito no código: uma oferta por dashboard,
   * cada uma com a propriedade dela.
   *
   * ESTA É A METADE DO NAVEGADOR. A outra é o Measurement Protocol, em
   * src/destinations/ga4.ts, e elas não se substituem — leia o cabeçalho de lá
   * antes de mexer em qualquer uma das duas. Resumo: daqui vai o que acontece
   * na página; de lá vai só a compra, que nasce no webhook horas depois de o
   * navegador ter fechado.
   */

  var GA4 = {
    page_view: "page_view",
    view_content: "view_item",
    add_to_cart: "add_to_cart",
    begin_checkout: "begin_checkout",
    lead: "generate_lead"
    /*
     * `purchase` NÃO ESTÁ NESTA LISTA, e esta é a linha mais importante do
     * bloco. A compra vai pelo servidor, quando o gateway confirma o
     * pagamento. Mandá-la daqui TAMBÉM faria o GA4 contar as duas: a receita
     * dobra no relatório, a taxa de conversão cai pela metade, e não há erro
     * nenhum para investigar.
     *
     * E não é só duplicação: a compra disparada no navegador conta vendas que
     * o gateway ainda vai recusar — pix que ninguém paga, cartão negado.
     *
     * A lista é FECHADA de propósito. Evento fora dela não vai para o GA4;
     * mandar nome desconhecido só encheria a propriedade de evento que
     * nenhum relatório lê.
     */
  };

  var ga4 = Array.isArray(cfg.ga4) ? cfg.ga4 : (cfg.ga4 ? [cfg.ga4] : []);
  var ga4Nosso = false;

  if (ga4.length) {
    /*
     * JÁ EXISTE gtag (ou GTM) nesta página? Então saímos da frente inteiros.
     *
     * Duas instalações de GA4 na mesma página contam tudo duas vezes, e o
     * sintoma é um relatório plausível — números maiores, nada quebrado. Se a
     * loja já tem o GA4 pelo tema ou pelo Tag Manager, o certo é ela ter UM
     * dos dois, e quem decide isso é quem configurou.
     *
     * `dataLayer` entra na checagem porque é o GTM: quem tem GTM quase sempre
     * configura o GA4 por dentro dele, e dali nós não enxergamos.
     *
     * Continuamos LENDO o `_ga` mesmo assim — ler cookie não duplica nada, e é
     * o que faz a compra do servidor cair na mesma pessoa que navegou.
     */
    if (window.gtag || window.dataLayer) {
      if (window.console) {
        console.warn("[rrtrack] esta página já tem gtag/dataLayer; o RRTrack não vai"
          + " mandar evento para o GA4, para não contar duas vezes.");
      }
    } else {
      window.dataLayer = window.dataLayer || [];
      /* `arguments` inteiro, como o snippet oficial: o gtag lê a lista crua. */
      window.gtag = function () { window.dataLayer.push(arguments); };
      window.gtag("js", new Date());

      /*
       * `send_page_view: false` em toda propriedade, e não é detalhe.
       *
       * O `config` do GA4 dispara um page_view sozinho. Como o page_view
       * também sai por `send()` logo abaixo — inclusive na navegação por
       * JavaScript, que o gtag sozinho não enxerga — deixar o automático
       * ligado daria dois por carregamento.
       */
      ga4.forEach(function (id) {
        window.gtag("config", String(id), { send_page_view: false });
      });

      var g = document.createElement("script");
      g.async = true;
      g.src = "https://www.googletagmanager.com/gtag/js?id="
        + encodeURIComponent(String(ga4[0]));
      var antesDoGa = document.getElementsByTagName("script")[0];
      antesDoGa.parentNode.insertBefore(g, antesDoGa);
      ga4Nosso = true;
    }
  }

  function aoGa4(name, params_) {
    if (!ga4Nosso || !window.gtag) return;
    var nome = GA4[name];
    if (!nome) return;
    /*
     * Os parâmetros já saem no dialeto do GA4 — `paramsDe` monta
     * items[{item_id,item_name,price,quantity}], value e currency, que é
     * exatamente o formato de e-commerce dele. Quem traduz para a Meta é
     * `paraMeta`, no sentido contrário.
     */
    try { window.gtag("event", nome, params_ || {}); } catch (e) {}
  }

  /*
   * Um pulso quando o `_ga` finalmente aparecer.
   *
   * O cookie do GA4 é criado pelo gtag.js, que carrega assíncrono — então o
   * nosso primeiro beacon sai ANTES dele existir, sempre. Sem isto, a sessão
   * de clique de quem entra e compra pelo mesmo caminho ficaria sem
   * `client_id`, e a compra do servidor seria recusada pelo adaptador (com
   * razão: sem client_id ela viraria um usuário novo no GA4).
   *
   * O pulso é o evento mais barato que existe aqui: o coletor atualiza a
   * sessão e responde 204 sem gravar linha de evento nenhuma.
   *
   * Roda também quando o gtag é da LOJA, e não nosso: ler o cookie serve
   * igual nos dois casos.
   */
  if (!gaClientId()) {
    (function esperarGa() {
      var tentativas = 0;
      var t = setInterval(function () {
        if (gaClientId()) { clearInterval(t); send("ping"); return; }
        /* Cinco segundos. Passou disso, não há GA4 nesta página. */
        if (++tentativas > 20) clearInterval(t);
      }, 250);
    })();
  }

  /* ---------------------------------------------------------------- envio */

  function send(name, params_, eventId) {
    /*
     * O id nasce aqui e serve aos dois lados. Era este o ponto: um gerador só.
     */
    var id = eventId || (name + "." + state.click_id + "." + Date.now());

    aoPixel(name, params_, id);
    aoGa4(name, params_);

    var body = {
      site_key: siteKey,
      click_id: state.click_id,
      external_id: state.external_id,
      event: name,
      event_id: id,
      attribution: state.attribution,
      fbp: state.fbp,
      fbc: state.fbc,
      /*
       * Identificadores do GA4, LIDOS e nunca criados.
       *
       * O gtag.js roda na página e cria o `_ga` sozinho. Inventar um aqui
       * faria o GA4 ver dois usuários onde há um — e a compra que sai daqui,
       * horas depois pelo webhook, precisa cair na MESMA pessoa que navegou,
       * senão ela chega sem origem e o funil quebra no último passo.
       *
       * Vazio quando não há gtag no site, e isso é correto: sem GA4 na página,
       * não há sessão a que ligar a compra.
       */
      ga_client_id: gaClientId(),
      ga_session_id: gaSessionId(),
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
        /*
         * Sem "include", o navegador DESCARTA o `Set-Cookie` da resposta entre
         * origens — e a página está em www.loja.com.br enquanto o coletor está
         * em t.loja.com.br, que são origens diferentes ainda que o mesmo site.
         * O sendBeacon acima já manda credencial por conta própria; este
         * caminho de reserva precisa pedir.
         */
        credentials: "include",
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
    /*
     * Só ÂNCORA se carimba: é o href que a gente consegue reescrever. Botão de
     * formulário não tem URL para carimbar — o destino é decidido pelo
     * servidor no POST, e aí o clickId precisa chegar ao checkout por outro
     * caminho. Incluí-los aqui faria `a.href` ser undefined e o laço pular,
     * sem erro e sem carimbar nada.
     */
    var sel = "[data-checkout-link], a[href*='checkout']";
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

  /*
   * ---------------------------------------------- produto lido da PÁGINA --
   *
   * A configuração no <head> resolve loja de oferta única: um produto, um
   * preço, escritos uma vez. Numa loja com catálogo ela não serve — são
   * dezenas de páginas, e ninguém vai gerar um script por produto.
   *
   * Então quando a configuração não diz qual é o produto, o script lê a
   * própria página. Três fontes, da mais confiável para a menos:
   *
   *   1. `ShopifyAnalytics.meta` — a Shopify publica o produto e a variante
   *      escolhida num objeto próprio. É o dado exato que a loja tem.
   *   2. JSON-LD `@type: Product` — padrão de mercado, e a maioria dos temas
   *      e plataformas emite.
   *   3. Open Graph — o mínimo, mas quase todo site tem.
   *
   * O IDENTIFICADOR SEGUE A MESMA ORDEM DO LADO DO PEDIDO: sku, depois id da
   * variante, depois id do produto — igual a gateways/shopify.ts. Não é
   * detalhe: a Meta casa ViewContent com Purchase pelo `content_id`, e se o
   * navegador mandar o id da variante enquanto o webhook manda o SKU, os dois
   * eventos falam de produtos diferentes para ela. Ninguém vê erro: só o
   * remarketing de carrinho abandonado não encontra ninguém.
   */

  function texto(v) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && isFinite(v)) return String(v);
    return undefined;
  }

  function numero(v) {
    if (typeof v === "number") return isFinite(v) ? v : undefined;
    if (typeof v === "string") {
      /* "1.234,56" e "1234.56" chegam os dois; a vírgula denuncia o decimal. */
      var t = v.indexOf(",") !== -1
        ? v.replace(/\./g, "").replace(",", ".")
        : v;
      var n = parseFloat(t.replace(/[^\d.-]/g, ""));
      return isFinite(n) ? n : undefined;
    }
    return undefined;
  }

  function varianteEscolhida() {
    try {
      var m = /[?&]variant=(\d+)/.exec(location.search);
      return m ? m[1] : null;
    } catch (e) { return null; }
  }

  function doShopify() {
    var m = window.ShopifyAnalytics && window.ShopifyAnalytics.meta;
    var p = m && m.product;
    if (!p) return null;

    var escolhida = varianteEscolhida();
    var v = null;
    if (p.variants && p.variants.length) {
      for (var i = 0; i < p.variants.length; i++) {
        if (escolhida && String(p.variants[i].id) === escolhida) { v = p.variants[i]; break; }
      }
      if (!v) v = p.variants[0];
    }

    var id = texto(v && v.sku) || texto(v && v.id) || texto(p.id);
    if (!id) return null;

    /*
     * O PREÇO DA SHOPIFY VEM EM CENTAVOS neste objeto — 8990 é R$ 89,90.
     * Mandar 8990 como valor faria a Meta otimizar para um retorno cem vezes
     * maior que o real, e o número é plausível o bastante para passar.
     */
    var preco = typeof (v && v.price) === "number" ? v.price / 100 : undefined;

    return {
      id: id,
      name: texto(v && v.name) || texto(p.title) || texto(p.name),
      price: preco,
      currency: (window.Shopify && window.Shopify.currency
        && window.Shopify.currency.active) || m.currency || undefined
    };
  }

  function doJsonLd() {
    var nos = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < nos.length; i++) {
      var dados;
      try { dados = JSON.parse(nos[i].textContent); } catch (e) { continue; }

      /* Pode vir solto, em lista, ou dentro de @graph. */
      var fila = [].concat(dados, (dados && dados["@graph"]) || []);
      for (var j = 0; j < fila.length; j++) {
        var o = fila[j];
        if (!o || typeof o !== "object") continue;
        var tipo = o["@type"];
        var ehProduto = tipo === "Product"
          || (Array.isArray(tipo) && tipo.indexOf("Product") !== -1);
        if (!ehProduto) continue;

        var oferta = Array.isArray(o.offers) ? o.offers[0] : o.offers;
        var id = texto(o.sku) || texto(o.productID) || texto(o.mpn)
          || texto(oferta && oferta.sku);
        if (!id) continue;

        return {
          id: id,
          name: texto(o.name),
          /* Aqui o preço é DECIMAL, ao contrário do objeto da Shopify. */
          price: numero(oferta && oferta.price),
          currency: texto(oferta && oferta.priceCurrency)
        };
      }
    }
    return null;
  }

  function meta(nome) {
    var el = document.querySelector('meta[property="' + nome + '"]')
      || document.querySelector('meta[name="' + nome + '"]');
    return el ? texto(el.getAttribute("content")) : undefined;
  }

  function doOpenGraph() {
    /*
     * PRECISA de sinal de produto, e não só de um título.
     *
     * Antes bastava `og:title`, e og:title toda página tem — a home virava
     * produto, o carrinho virava produto, e o funil registrava "viu o
     * produto" de gente que só abriu o site. Etapa inflada é pior que etapa
     * zerada: a taxa de conversão despenca e parece problema de oferta.
     *
     * Sinal de produto é uma destas três: `og:type` dizendo produto, um preço
     * declarado, ou um código de item de varejo.
     */
    var preco = numero(meta("product:price:amount") || meta("og:price:amount"));
    var codigo = meta("product:retailer_item_id") || meta("og:product_id");
    var tipo = (meta("og:type") || "").toLowerCase();

    if (tipo.indexOf("product") === -1 && preco === undefined && !codigo) return null;

    var nome = meta("og:title");
    var id = codigo || nome;
    if (!id) return null;

    return { id: id, name: nome, price: preco,
      currency: meta("product:price:currency") || meta("og:price:currency") };
  }

  /* O que a página está mostrando agora, e a variante escolhida agora. */
  var lidoDaPagina = null;
  var varianteLida = null;

  function detectar() {
    var v = varianteEscolhida();
    /*
     * Relê quando a variante muda. O tema troca `?variant=` na URL sem
     * recarregar a página, e sem isto o `add_to_cart` sairia com o preço e o
     * SKU de Preto numa compra de Marrom.
     */
    if (lidoDaPagina && varianteLida === v) return lidoDaPagina;
    varianteLida = v;
    try {
      lidoDaPagina = doShopify() || doJsonLd() || doOpenGraph();
    } catch (e) { lidoDaPagina = null; }
    return lidoDaPagina;
  }

  function produtoPadrao() {
    /*
     * A configuração e o `setProduct` vencem a página: quem escreveu ali foi
     * explícito, e a leitura automática é o que sobra quando ninguém disse.
     */
    return produtoAtual || detectar();
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

    /*
     * Terceiro caminho, e o que faz loja com catálogo funcionar sem configurar
     * nada: a própria página se identificou como página de produto.
     *
     * `detectar()` só devolve algo quando a página publica um produto — pela
     * Shopify, por JSON-LD ou por Open Graph. Página de coleção, home e
     * carrinho não publicam, então não disparam. É exatamente a distinção que
     * o `data-rr-view` pedia à mão, feita sozinha.
     */
    if (cfg.viewContentOnLoad || detectar()) {
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
    /*
     * Os seletores da Shopify entram por padrão.
     *
     * Antes só reconhecia `data-add-to-cart` e `data-rr-add-to-cart`, que são
     * atributos NOSSOS — nenhum tema de loja tem. Numa Shopify o botão é um
     * submit dentro do formulário que posta em /cart/add, ou tem name="add".
     * Sem isto, "adicionou ao carrinho" ficava em zero para sempre, e o funil
     * mostrava a etapa como se ninguém clicasse.
     */
    var selCarrinho = cfg.addToCartSelector
      || "[data-add-to-cart], [data-rr-add-to-cart],"
      + " form[action*='/cart/add'] [type='submit'], button[name='add'],"
      + " [name='add'], .product-form__submit, .add-to-cart, .btn--add-to-cart";
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
    /*
     * O botão de finalizar compra da Shopify NÃO É UM LINK.
     *
     * É um submit dentro do formulário do carrinho, com name="checkout" — e o
     * seletor só olhava `a[href*='checkout']`. Numa loja real a pessoa clicou
     * em finalizar e o "iniciou o checkout" ficou em zero, porque o botão não
     * era uma âncora.
     *
     * A troca de domínio acontece depois, no redirecionamento do servidor;
     * por isso o evento tem de sair no CLIQUE, que é o último instante em que
     * ainda estamos na página.
     */
    var sel = cfg.checkoutSelector
      || "[data-checkout-link], a[href*='checkout'],"
      + " button[name='checkout'], [name='checkout'],"
      + " .cart__checkout, .checkout-button";
    var link = ev.target && ev.target.closest ? ev.target.closest(sel) : null;
    if (link && link.getAttribute("data-rr-ic") !== "1") {
      link.setAttribute("data-rr-ic", "1");

      /*
       * Carimba AGORA, no clique, e não só na varredura periódica.
       *
       * O link do checkout externo costuma ser montado por JavaScript no
       * instante do clique — quando a varredura passou, ele não existia. Numa
       * loja real o `utm_source` chegou ao checkout.pagou.ai e o `sck` não:
       * o link nasceu depois do carimbo, e a venda voltou sem o identificador
       * do clique. Ela entra assim mesmo, atribuída por UTM, que é um palpite
       * bom em vez de uma certeza.
       *
       * Este é o último instante em que dá para escrever na URL.
       */
      try {
        if (link.href && link.getAttribute("data-rr-done") !== "1") {
          link.href = decorate(link.href);
          link.setAttribute("data-rr-done", "1");
        }
      } catch (e) { /* link sem href utilizável: segue sem carimbo */ }

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
    /*
     * O que os eventos estão levando agora — útil para conferir no console.
     *
     * `produtoPadrao()`, e não `produtoAtual`: desde que o script lê o produto
     * da própria página, o que os eventos levam pode não ter vindo da
     * configuração. Devolver só o configurado fazia `rr('product')` dizer
     * `null` numa página que estava mandando produto certinho — e quem for
     * conferir no console concluiria que está quebrado.
     */
    product: function () { return produtoPadrao(); },
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

  /*
   * Tenta de novo por alguns segundos, e o motivo é concreto.
   *
   * `ShopifyAnalytics.meta` é publicado pelo script da própria Shopify, que
   * costuma carregar DEPOIS do nosso. Na primeira leitura ele não existe, a
   * detecção cai no JSON-LD ou no Open Graph, e numa página de produto onde só
   * a Shopify tinha o dado o `view_content` simplesmente não saía — foi o que
   * aconteceu numa loja real: page_view na página do produto, e nenhum
   * view_content.
   *
   * Para quando achar, e desiste depois de três segundos. `jaViu` garante que
   * só sai um por página, então repetir a tentativa não repete o evento.
   */
  (function insistir() {
    var tentativas = 0;
    var t = setInterval(function () {
      if (jaViu || ++tentativas > 10) { clearInterval(t); return; }
      /* Esquece o que leu antes: agora pode haver fonte melhor. */
      lidoDaPagina = null;
      varianteLida = null;
      verProduto();
    }, 300);
  })();

  /*
   * ------------------------------------ navegação que não recarrega a página
   *
   * Num site clássico cada link é um carregamento novo: o script roda de novo,
   * e `page_view` sai sozinho. Tema com navegação por JavaScript troca o
   * conteúdo sem recarregar nada — e aí o script rodou UMA vez, na primeira
   * página. A pessoa visita seis produtos e a Meta vê um PageView e um
   * ViewContent.
   *
   * Não dá erro. Some dado, e some do jeito pior: o funil mostra menos gente
   * vendo produto do que viu, e a otimização da campanha trabalha com menos
   * sinal do que existe.
   *
   * Só o CAMINHO conta como página nova. Mudança de query sozinha é filtro de
   * coleção ou troca de variante — disparar ali inflaria o `page_view` a cada
   * clique num filtro, e número inflado é pior que número faltando, porque
   * ninguém desconfia de um número grande.
   */
  var caminhoAtual = location.pathname;

  function trocouDePagina() {
    if (location.pathname === caminhoAtual) return;
    caminhoAtual = location.pathname;

    /* A página é outra: o produto lido e o "já viu" da anterior não valem. */
    lidoDaPagina = null;
    varianteLida = null;
    jaViu = false;

    send("page_view");
    verProduto();
  }

  /*
   * `pushState` e `replaceState` não emitem evento nenhum — são chamadas de
   * função. Envolver as duas é a única forma de saber que a navegação
   * aconteceu, e o `try` existe porque outro script pode ter chegado antes e
   * deixado a propriedade travada.
   */
  try {
    ["pushState", "replaceState"].forEach(function (nome) {
      var original = history[nome];
      if (typeof original !== "function") return;
      history[nome] = function () {
        var r = original.apply(this, arguments);
        /* No fim da fila: o tema costuma trocar o conteúdo logo depois. */
        setTimeout(trocouDePagina, 0);
        return r;
      };
    });
  } catch (e) { /* sem isto, só perde a navegação por JavaScript */ }

  window.addEventListener("popstate", trocouDePagina);

  /*
   * ------------------------------- o clickId na PRÓPRIA URL da loja
   *
   * Descoberto observando uma venda real: o checkout externo recebeu
   * `utm_source`, `utm_campaign`, `utm_medium` e `utm_term` — exatamente os
   * parâmetros que estavam na URL da loja. O app do gateway COPIA A QUERY DA
   * VITRINE ao montar o endereço do checkout.
   *
   * Carimbar o link não bastou: o botão de finalizar da Shopify é um submit,
   * não uma âncora, e o destino é decidido no servidor. Mas o que está na URL
   * da loja atravessa — foi assim que as UTMs chegaram.
   *
   * Então o clickId entra na própria URL. `replaceState` não cria entrada no
   * histórico, então o botão voltar continua se comportando como antes, e a
   * pessoa não vê a página recarregar.
   *
   * Não substitui os outros caminhos: o `note_attributes` da Shopify e o
   * carimbo no clique continuam valendo, porque cada arranjo perde um deles.
   */
  (function clickIdNaUrl() {
    var alvo = cfg.passthroughField || "sck";
    try {
      var u = new URL(location.href);
      if (u.searchParams.get(alvo)) return;

      u.searchParams.set(alvo, state.click_id);
      /*
       * `replaceState` pode falhar em about:blank, sandbox e alguns
       * navegadores embutidos. Falhar aqui não pode derrubar o rastreamento:
       * perde-se este caminho e os outros continuam.
       */
      history.replaceState(history.state, "", u.toString());
    } catch (e) { /* segue sem */ }
  })();

  /*
   * ------------------------------------------- o clickId dentro do carrinho
   *
   * Numa Shopify, o que o carrinho carrega chega ao pedido: `cart.attributes`
   * vira `note_attributes` no webhook. É o único campo que sobrevive à
   * travessia do checkout, inclusive quando o checkout é de outro domínio.
   *
   * Isto existe porque numa loja real o `note_attributes` chegou VAZIO e a
   * venda entrou sem origem. A solução até então era um trecho colado no
   * tema — que depende de alguém mexer no tema, e enquanto não mexe a venda
   * entra órfã sem nada acusando.
   *
   * Roda uma vez por aba, e só quando há carrinho de Shopify de verdade. O
   * `sessionStorage` evita repetir a chamada a cada página; `keepalive` faz a
   * gravação sobreviver se a pessoa clicar em comprar no mesmo instante.
   */
  (function carimbarCarrinho() {
    if (!window.Shopify) return;
    try {
      if (sessionStorage.getItem("_rr_cart") === state.click_id) return;
    } catch (e) { /* aba anônima sem storage: manda de novo, não custa */ }

    var atributos = {};
    atributos[cfg.cartAttribute || "rr_click_id"] = state.click_id;

    try {
      fetch("/cart/update.js", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attributes: atributos }),
        keepalive: true,
        credentials: "same-origin"
      }).then(function () {
        try { sessionStorage.setItem("_rr_cart", state.click_id); } catch (e) {}
      }).catch(function () { /* loja sem esta rota: segue sem */ });
    } catch (e) { /* navegador sem fetch: segue sem */ }
  })();

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
