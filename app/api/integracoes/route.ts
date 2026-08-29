/*
 * Grava as integrações de uma loja: contas de anúncio, gateways e pixels.
 *
 * Uma rota só para os três porque a diferença entre eles é qual tabela recebe,
 * não o que precisa acontecer antes: confirmar sessão, confirmar que a pessoa
 * tem acesso àquela loja, cifrar segredo. Espalhar isso por três rotas é como
 * uma delas acaba esquecendo a confirmação de acesso.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { adAccounts, destinations, gatewayConnections, sites } from "@/db/schema";
import { exigirSessao } from "@/core/sessao";
import { acessoALoja } from "@/core/auth";
import { encryptValue } from "@/core/crypto";
import { getGateway } from "@/gateways/registry";

export const runtime = "nodejs";

const PLATAFORMAS_ANUNCIO = ["meta", "google", "tiktok"];
const PLATAFORMAS_PIXEL = ["meta", "google", "tiktok"];

function texto(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/*
 * Data de vencimento da credencial, como AAAA-MM-DD.
 *
 * `undefined` quer dizer "não mexer"; `null` quer dizer "apagar". A diferença
 * importa: um formulário que manda o campo vazio por não ter perguntado nada
 * não pode apagar a data que a loja já tinha cadastrado.
 */
function vencimento(v: unknown): Date | null | undefined {
  if (v === null) return null;
  const t = texto(v);
  if (!t) return undefined;
  const d = new Date(t.length === 10 ? t + "T12:00:00Z" : t);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const aleatorio = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");

export async function POST(req: Request): Promise<Response> {
  const sessao = await exigirSessao();
  if (!sessao.ok) return sessao.resposta;

  const corpo = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const tenantId = texto(corpo.tenantId);
  if (!tenantId) return Response.json({ erro: "loja não informada" }, { status: 400 });

  /*
   * O pedido diz qual loja, mas quem confirma é o banco. Sem esta linha,
   * bastaria trocar o id no corpo da requisição para escrever na loja de
   * outra conta.
   */
  const loja = await acessoALoja(sessao.ctx.usuario.userId, tenantId);
  if (!loja) return Response.json({ erro: "não encontrado" }, { status: 404 });

  const tipo = texto(corpo.tipo);

  try {
    switch (tipo) {
      /* ------------------------------------------------ conta de anúncio */
      case "conta_anuncio": {
        const plataforma = texto(corpo.plataforma);
        const externalId = texto(corpo.externalId);
        if (!plataforma || !PLATAFORMAS_ANUNCIO.includes(plataforma) || !externalId) {
          return Response.json({ erro: "plataforma e id da conta são obrigatórios" }, { status: 400 });
        }

        const cred: Record<string, string> = {};
        for (const chave of ["accessToken", "refreshToken", "developerToken", "clientId", "clientSecret", "loginCustomerId"]) {
          const v = texto(corpo[chave]);
          if (v) cred[chave] = await encryptValue(v);
        }

        const [existente] = await db.select({ id: adAccounts.id }).from(adAccounts)
          .where(and(
            eq(adAccounts.tenantId, tenantId),
            eq(adAccounts.platform, plataforma),
            eq(adAccounts.externalId, externalId),
          )).limit(1);

        if (existente) {
          const venceAd = vencimento(corpo.expiraEm);
          await db.update(adAccounts).set({
            /* Ver a nota longa no caso "gateway": ausente é "não mexa". */
            ...(texto(corpo.label) ? { label: texto(corpo.label)! } : {}),
            ...(venceAd !== undefined ? { credentialsExpireAt: venceAd } : {}),
            /* Credencial vazia não apaga a que já existe: quem só renomeou a
               conta não deveria perder o token por causa disso. */
            ...(Object.keys(cred).length ? { credentials: cred } : {}),
            active: corpo.active !== false,
          }).where(eq(adAccounts.id, existente.id));
          return Response.json({ ok: true, id: existente.id, novo: false });
        }

        const [nova] = await db.insert(adAccounts).values({
          tenantId, platform: plataforma, externalId,
          label: texto(corpo.label) ?? plataforma,
          credentials: cred, active: true,
          credentialsExpireAt: vencimento(corpo.expiraEm) ?? null,
        }).returning({ id: adAccounts.id });

        return Response.json({ ok: true, id: nova!.id, novo: true });
      }

      /* ------------------------------------------------------- gateway */
      case "gateway": {
        const gateway = texto(corpo.gateway);
        if (!gateway || !getGateway(gateway)) {
          return Response.json({ erro: "gateway desconhecido" }, { status: 400 });
        }

        /*
         * As chaves aceitas saem do proprio adaptador.
         *
         * Continua sendo lista fechada — o corpo vem do navegador, e gravar
         * qualquer chave que chegasse deixaria o cliente escolher o que entra
         * cifrado no banco. So que agora a lista e a MESMA que a tela usa para
         * montar o formulario, em vez de uma segunda copia aqui. Duas listas
         * divergiriam no dia em que alguem acrescentasse um campo num lugar
         * so, e o sintoma seria o campo aparecer na tela, a pessoa preencher,
         * e o valor sumir sem erro nenhum.
         *
         * `apiVersion` nao esta declarada em adaptador nenhum: e um ajuste de
         * manutencao da Shopify, sem campo na tela, que entra so por esta rota.
         */
        const adaptador = getGateway(gateway)!;
        const aceitas = new Set([
          ...(adaptador.credenciais ?? []).map((c) => c.chave),
          "apiVersion",
        ]);

        const cred: Record<string, string> = {};
        for (const chave of aceitas) {
          const v = texto(corpo[chave]);
          if (v) cred[chave] = await encryptValue(v);
        }

        /*
         * Editar aponta para UMA conexao, pelo id. Sem id, cria outra.
         *
         * Antes isto procurava por (loja, gateway) e so podia haver uma de
         * cada. Duas consequencias, as duas ruins: nao dava para ligar duas
         * lojas Shopify nem dois ERPs, e — pior — quando passassem a existir
         * duas, editar a credencial de uma escreveria na primeira que a busca
         * encontrasse. Sem erro, e com a venda parando de chegar do lado que
         * ninguem mexeu.
         */
        const id = texto(corpo.id);

        const [existente] = id
          ? await db.select({ id: gatewayConnections.id, segredo: gatewayConnections.webhookSecret })
            .from(gatewayConnections)
            .where(and(
              eq(gatewayConnections.tenantId, tenantId),
              eq(gatewayConnections.id, id),
            ))
            .limit(1)
          : [undefined];

        if (id && !existente) {
          return Response.json({ erro: "conexão não encontrada" }, { status: 404 });
        }

        if (existente) {
          const venceGw = vencimento(corpo.expiraEm);
          await db.update(gatewayConnections).set({
            /*
             * Nome ausente NÃO vira o id do gateway.
             *
             * O `?? gateway` estava aqui desde quando o nome não era editável
             * e servia de rótulo padrão na criação. Numa edição ele apagava o
             * nome: quem abriu a linha só para colar o segredo de assinatura
             * via "Transforlar" virar "shopify" — sem aviso, e sem entender o
             * que tinha feito de errado.
             *
             * Campo que não veio no corpo significa "não mexa nisso", e não
             * "apague". Vale para a credencial logo abaixo pelo mesmo motivo.
             */
            ...(texto(corpo.label) ? { label: texto(corpo.label)! } : {}),
            ...(venceGw !== undefined ? { credentialsExpireAt: venceGw } : {}),
            ...(Object.keys(cred).length ? { credentials: cred } : {}),
            active: corpo.active !== false,
          }).where(eq(gatewayConnections.id, existente.id));
          /* O segredo do webhook NUNCA é regerado numa edição: trocá-lo
             invalidaria a URL já configurada no painel do gateway, e as vendas
             parariam de chegar sem nenhum erro visível. */
          return Response.json({ ok: true, id: existente.id, segredo: existente.segredo, novo: false });
        }

        /*
         * Prefixo diferente para a entrada por API porque a coisa e diferente:
         * `whsec_` vive no caminho de uma URL que o gateway configura; o token
         * da API vai num cabecalho Authorization, como todo token. O nome
         * errado fazia a pessoa procurar onde colar uma URL.
         */
        const segredo = (adaptador.especie === "api" ? "rrt_" : "whsec_") + aleatorio(24);
        const [nova] = await db.insert(gatewayConnections).values({
          tenantId, gateway,
          label: texto(corpo.label) ?? gateway,
          credentials: cred, webhookSecret: segredo, active: true,
          /*
           * Já nasce com a tabela de taxas do gateway, quando ele publica uma.
           *
           * Vazia significa "não sei", e o painel então mostra taxa R$ 0,00 e
           * declara um lucro que não existe. Quem abre uma loja nova não
           * deveria ter que redigitar a mesma tabela que já preencheu na
           * outra — e enquanto não preenche, o lucro na tela está errado para
           * cima, que é o erro que menos levanta suspeita.
           *
           * Continua sendo estimativa, e continua perdendo para a taxa que o
           * webhook informar.
           */
          fees: (adaptador.taxasPadrao ?? {}) as Record<string, unknown>,
          credentialsExpireAt: vencimento(corpo.expiraEm) ?? null,
        }).returning({ id: gatewayConnections.id });

        return Response.json({ ok: true, id: nova!.id, segredo, novo: true });
      }

      /* --------------------------------------------------------- taxas */

      /*
       * Quanto o gateway cobra, por método. Só é consultada quando o webhook
       * não informa a taxa — ver core/taxas.ts.
       */
      case "taxas": {
        const gateway = texto(corpo.gateway);
        if (!gateway) return Response.json({ erro: "gateway ausente" }, { status: 400 });

        /* Pelo id quando vier: podendo haver duas do mesmo gateway, gravar a
           tabela de taxas por marca acertaria a conexao errada. */
        const idTaxas = texto(corpo.id);
        const [conexao] = await db.select({ id: gatewayConnections.id })
          .from(gatewayConnections)
          .where(and(
            eq(gatewayConnections.tenantId, tenantId),
            idTaxas ? eq(gatewayConnections.id, idTaxas) : eq(gatewayConnections.gateway, gateway),
          ))
          .limit(1);

        if (!conexao) return Response.json({ erro: "gateway não conectado" }, { status: 404 });

        const t = corpo.taxas;
        if (!t || typeof t !== "object") {
          return Response.json({ erro: "tabela inválida" }, { status: 400 });
        }

        /*
         * Percentual acima de 100 é sempre erro de digitação — alguém escreveu
         * 399 querendo 3,99. Aceitar produziria taxa maior que a venda e
         * faturamento líquido negativo espalhado pelo painel inteiro.
         */
        const sane = JSON.stringify(t);
        if (/"percentual":\s*(1[0-9][0-9]|[2-9][0-9][0-9]|\d{4,})/.test(sane)) {
          return Response.json({ erro: "percentual acima de 100 — confira a vírgula" }, { status: 400 });
        }

        await db.update(gatewayConnections)
          .set({ fees: t as Record<string, unknown> })
          .where(eq(gatewayConnections.id, conexao.id));

        return Response.json({ ok: true });
      }

      /* --------------------------------------------------------- pixel */
      /* ---------------------------------------------------------- site */

      /*
       * O endereço do site desta loja.
       *
       * A chave pública NÃO muda quando o domínio muda. Ela é o que o snippet
       * carrega, e regenerá-la faria o script parar de funcionar em toda página
       * já publicada — sem erro visível, só eventos que somem.
       */
      case "site": {
        const bruto = texto(corpo.dominio) ?? "";
        /* Aceita colado do navegador, com protocolo, www e barra no fim. */
        const dominio = bruto
          .trim().toLowerCase()
          .replace(/^https?:\/\//, "")
          .replace(/^www\./, "")
          .replace(/\/.*$/, "");

        if (!dominio || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(dominio)) {
          return Response.json({ erro: "endereço inválido" }, { status: 400 });
        }

        const [emUso] = await db.select({ id: sites.id, tenantId: sites.tenantId })
          .from(sites).where(eq(sites.domain, dominio)).limit(1);

        if (emUso && emUso.tenantId !== tenantId) {
          return Response.json({ erro: "esse domínio já está em outro dashboard" }, { status: 409 });
        }

        const [existente] = await db.select({ id: sites.id, chave: sites.publicKey })
          .from(sites).where(eq(sites.tenantId, tenantId)).limit(1);

        if (existente) {
          await db.update(sites).set({
            domain: dominio,
            collectorHost: `t.${dominio}`,
            active: true,
          }).where(eq(sites.id, existente.id));
          return Response.json({ ok: true, dominio, chave: existente.chave, novo: false });
        }

        const chave = "pk_" + aleatorio(12);
        await db.insert(sites).values({
          tenantId, domain: dominio, collectorHost: `t.${dominio}`,
          publicKey: chave, active: true,
        });
        return Response.json({ ok: true, dominio, chave, novo: true });
      }

      /*
       * O produto da página, e se a página de entrada já é a do produto.
       *
       * Existe porque o funil tinha duas etapas condenadas a ficar em zero.
       * O rr.js só dispara "viu o produto" quando acha `data-rr-view` no HTML
       * — o que faz sentido numa loja com catálogo, e nenhum sentido numa
       * oferta de página única, onde a pessoa cai direto no produto. Marcar
       * isto aqui faz o snippet sair com a instrução pronta.
       *
       * O produto é opcional, mas vale muito: é ele que dá VALOR aos eventos.
       * Sem preço, a Meta recebe "alguém adicionou ao carrinho" e consegue
       * otimizar por volume; com preço, ela otimiza por retorno.
       */
      case "produto": {
        const [site] = await db.select({ id: sites.id })
          .from(sites).where(eq(sites.tenantId, tenantId)).limit(1);

        if (!site) {
          return Response.json({ erro: "cadastre o endereço do site primeiro" }, { status: 400 });
        }

        const preco = Number(corpo.preco);
        if (corpo.preco !== undefined && corpo.preco !== null && corpo.preco !== ""
          && (!Number.isFinite(preco) || preco < 0)) {
          return Response.json({ erro: "preço inválido" }, { status: 400 });
        }

        const config = {
          viewContentOnLoad: corpo.paginaDeProduto === true,
          productId: texto(corpo.id),
          productName: texto(corpo.nome),
          /* Centavo inteiro no banco, como em todo lugar; o snippet devolve
             para reais na hora de escrever, porque é o que o rr.js espera. */
          productPriceCents: Number.isFinite(preco) && preco > 0
            ? Math.round(preco * 100) : undefined,
        };

        await db.update(sites).set({ config }).where(eq(sites.id, site.id));
        return Response.json({ ok: true, config });
      }

      /*
       * Gera uma chave de site nova.
       *
       * Operação destrutiva por natureza: o script já publicado carrega a
       * chave antiga, e a partir daqui ele para de ser aceito. Não há erro
       * visível — os eventos simplesmente somem — então a tela precisa avisar
       * e o pedido precisa ser explícito.
       */
      case "regerar_chave": {
        const [site] = await db.select({ id: sites.id })
          .from(sites).where(eq(sites.tenantId, tenantId)).limit(1);

        if (!site) return Response.json({ erro: "nenhum site cadastrado" }, { status: 404 });

        const chave = "pk_" + aleatorio(12);
        await db.update(sites).set({ publicKey: chave }).where(eq(sites.id, site.id));
        return Response.json({ ok: true, chave });
      }

      case "pixel": {
        const plataforma = texto(corpo.plataforma);
        const externalId = texto(corpo.externalId);
        const token = texto(corpo.token);

        if (!plataforma || !PLATAFORMAS_PIXEL.includes(plataforma) || !externalId) {
          return Response.json({ erro: "plataforma e id do pixel são obrigatórios" }, { status: 400 });
        }

        const config: Record<string, unknown> = {};
        if (Array.isArray(corpo.eventos)) config.eventos = corpo.eventos;
        if (texto(corpo.textoBotaoCheckout)) config.textoBotaoCheckout = texto(corpo.textoBotaoCheckout);

        const [existente] = await db.select({ id: destinations.id }).from(destinations)
          .where(and(
            eq(destinations.tenantId, tenantId),
            eq(destinations.platform, plataforma),
            eq(destinations.externalId, externalId),
          )).limit(1);

        /*
         * O Google não usa um token só: precisa de OAuth2 completo, do
         * developer token que ele mesmo aprova, e do nome do recurso da ação
         * de conversão. Cada plataforma guarda o que a dela exige.
         */
        const credenciais: Record<string, string> = {};
        if (token) credenciais.accessToken = await encryptValue(token);
        for (const chave of ["developerToken", "clientId", "clientSecret", "refreshToken", "loginCustomerId", "conversionAction"]) {
          const v = texto(corpo[chave]);
          if (v) credenciais[chave] = await encryptValue(v);
        }
        const temCredencial = Object.keys(credenciais).length > 0;

        if (existente) {
          await db.update(destinations).set({
            label: texto(corpo.label) ?? `Pixel ${plataforma}`,
            ...(temCredencial ? { credentials: credenciais } : {}),
            config,
            active: corpo.active !== false,
          }).where(eq(destinations.id, existente.id));

          /* Só toca no código de teste quando veio valor. Apagá-lo em silêncio
             faria os eventos sumirem da aba de teste sem nada parar de
             funcionar — a pior forma de quebrar. */
          const teste = texto(corpo.testEventCode);
          if (teste) {
            await db.update(destinations).set({ testEventCode: teste })
              .where(eq(destinations.id, existente.id));
          }
          return Response.json({ ok: true, id: existente.id, novo: false });
        }

        if (!temCredencial) {
          return Response.json({ erro: "credencial é obrigatória para criar" }, { status: 400 });
        }

        const [nova] = await db.insert(destinations).values({
          tenantId, platform: plataforma, externalId,
          label: texto(corpo.label) ?? `Pixel ${plataforma}`,
          credentials: credenciais,
          config,
          testEventCode: texto(corpo.testEventCode) ?? null,
          active: true,
        }).returning({ id: destinations.id });

        return Response.json({ ok: true, id: nova!.id, novo: true });
      }

      default:
        return Response.json({ erro: "tipo inválido" }, { status: 400 });
    }
  } catch (e) {
    return Response.json(
      { erro: e instanceof Error ? e.message : "falha ao gravar" },
      { status: 500 },
    );
  }
}

/* Desativa uma integração. Não apaga: o histórico de disparos aponta para ela. */
export async function DELETE(req: Request): Promise<Response> {
  const sessao = await exigirSessao();
  if (!sessao.ok) return sessao.resposta;

  const url = new URL(req.url);
  const tenantId = url.searchParams.get("tenantId");
  const tipo = url.searchParams.get("tipo");
  const id = url.searchParams.get("id");

  if (!tenantId || !tipo || !id) {
    return Response.json({ erro: "parâmetros faltando" }, { status: 400 });
  }

  const loja = await acessoALoja(sessao.ctx.usuario.userId, tenantId);
  if (!loja) return Response.json({ erro: "não encontrado" }, { status: 404 });

  const tabela = tipo === "conta_anuncio" ? adAccounts
    : tipo === "gateway" ? gatewayConnections
    : tipo === "pixel" ? destinations : null;

  if (!tabela) return Response.json({ erro: "tipo inválido" }, { status: 400 });

  await db.update(tabela).set({ active: false })
    .where(and(eq(tabela.id, id), eq(tabela.tenantId, tenantId)));

  return Response.json({ ok: true });
}
