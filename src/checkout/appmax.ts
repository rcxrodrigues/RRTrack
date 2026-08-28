/*
 * Cobrança pela Appmax, a partir do nosso checkout.
 *
 * Este arquivo é o oposto de `src/gateways/appmax.ts`: lá recebemos o que a
 * Appmax conta sobre uma venda que aconteceu em outro lugar; aqui a venda
 * acontece porque nós mandamos.
 *
 * A ordem das chamadas é imposta por ela e não dá para encurtar:
 *
 *   1. POST /oauth2/token          — Bearer do lojista, vale uma hora
 *   2. POST /v1/customers          — devolve customer_id
 *   3. POST /v1/orders             — devolve order_id, status "pendente"
 *   4. POST /v1/payments/{método}  — é o que efetiva a cobrança
 *
 * O CARTÃO NUNCA PASSA POR AQUI. O navegador troca número, CVV e validade por
 * um token direto com a Appmax, e só o token chega ao nosso servidor. Isso não
 * é preciosismo: é a diferença entre o questionário PCI mais simples (SAQ-A) e
 * o regime completo, que exige varredura trimestral e auditoria. Ver
 * `src/ui/checkout-form.tsx`, que carrega o appmax.min.js para isso.
 *
 * Uma decisão que parece exagero e não é: entre criar o pedido e cobrá-lo,
 * conferimos o total lendo o pedido de volta. A documentação da Appmax não diz
 * em lugar nenhum se `unit_value` é centavo ou real — o exemplo dela usa 12300
 * para um livro, que só faz sentido como centavo, mas "só faz sentido" já me
 * enganou três vezes neste projeto. Se a unidade for outra, o erro não estoura:
 * cobra cem vezes mais ou cem vezes menos e ninguém vê até o estorno. A
 * conferência transforma isso num erro barulhento antes de o cartão ser tocado.
 */

/*
 * Os tipos vivem em `tipos.ts`, não aqui.
 *
 * Enquanto a Appmax era o único jeito de cobrar, era honesto guardá-los neste
 * arquivo. Deixou de ser no instante em que houve um segundo gateway: tipo
 * compartilhado morando dentro de uma implementação é como o resto do sistema
 * aprende a depender dela sem ninguém ter decidido isso.
 *
 * Reexportados porque quem já importava daqui continua funcionando.
 */
import type {
  CompradorCheckout, DadosPix, ItemCobrado, PagamentoPedido,
  ParametrosCompra, ResultadoCompra, CobradorCheckout,
} from "./tipos";

export type {
  CompradorCheckout, DadosPix, ItemCobrado, PagamentoPedido,
  ParametrosCompra, ResultadoCompra,
};

import type { GatewayCredentials } from "../gateways/types";

const API = "https://api.appmax.com.br";
const AUTH = "https://auth.appmax.com.br/oauth2/token";

/*
 * Para onde o NAVEGADOR manda o cartão — nunca este servidor.
 *
 * Declarado aqui e não na tela porque é característica do gateway, não do
 * formulário: quando houver um segundo cobrador, cada um traz o seu, e a tela
 * passa a só perguntar "para onde eu mando?".
 */
const TOKENIZE =
  "https://hdixjlm06b.execute-api.sa-east-1.amazonaws.com/production/v1/payments/tokenize";

/* ----------------------------------------------------------- utilidades -- */

/*
 * Nome próprio como a pessoa escreveu.
 *
 * `splitName` de core/hash.ts existe para hash de correspondência: ele baixa
 * caixa e tira acento, o que é certo para o CAPI e errado para a nota — "joao"
 * no lugar de "João". Aqui o dado vai para o comprador ver.
 */
function partirNome(completo: string): { primeiro: string; ultimo: string } {
  const partes = completo.trim().split(/\s+/).filter(Boolean);
  const primeiro = partes[0] ?? "";
  const ultimo = partes[partes.length - 1] ?? "";
  /* A Appmax exige sobrenome; com nome de uma palavra só, repetimos. */
  return { primeiro, ultimo: partes.length > 1 ? ultimo : primeiro };
}

const digitos = (s: string): string => s.replace(/\D/g, "");

/*
 * Token do lojista, guardado enquanto a instância viver.
 *
 * Vale 3600s e cada checkout precisaria de um. Numa instância quente isso
 * economiza uma ida à Appmax por venda — e numa fria não custa nada, porque o
 * mapa nasce vazio. A margem de 60s evita usar um token que expira no caminho.
 */
const tokens = new Map<string, { valor: string; expiraEm: number }>();

async function obterToken(cred: GatewayCredentials): Promise<string> {
  const id = cred.clientId;
  const segredo = cred.clientSecret;
  if (!id || !segredo) {
    throw new Error("conexão da Appmax sem client_id/client_secret");
  }

  const guardado = tokens.get(id);
  if (guardado && guardado.expiraEm > Date.now()) return guardado.valor;

  const res = await fetch(AUTH, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: id,
      client_secret: segredo,
    }),
  });

  if (!res.ok) throw new Error(`Appmax recusou as credenciais (${res.status})`);

  const j = await res.json() as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error("Appmax não devolveu access_token");

  tokens.set(id, {
    valor: j.access_token,
    expiraEm: Date.now() + ((j.expires_in ?? 3600) - 60) * 1000,
  });
  return j.access_token;
}

/*
 * Mensagem de erro legível a partir do corpo da Appmax.
 *
 * Ela devolve formatos diferentes conforme o erro (`message`, `error`, ou um
 * objeto `errors` com lista por campo). Sem isto, toda falha viraria "422" na
 * tela do comprador, que não diz o que corrigir.
 */
function motivoDoErro(corpo: unknown, status: number): string {
  if (corpo && typeof corpo === "object") {
    const o = corpo as Record<string, unknown>;
    if (typeof o.message === "string" && o.message.trim()) return o.message;
    if (typeof o.error === "string" && o.error.trim()) return o.error;

    const erros = o.errors ?? (o.data as Record<string, unknown> | undefined)?.errors;
    if (erros && typeof erros === "object") {
      const lista = Object.values(erros as Record<string, unknown>)
        .flatMap((v) => (Array.isArray(v) ? v : [v]))
        .filter((v): v is string => typeof v === "string");
      if (lista.length) return lista.join("; ");
    }
  }
  return `Appmax respondeu ${status}`;
}

async function chamar(
  caminho: string,
  token: string,
  corpo: unknown,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${API}${caminho}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(corpo),
  });

  /* Corpo vazio ou não-JSON acontece em 5xx; não pode derrubar a cobrança. */
  let json: Record<string, unknown> = {};
  try { json = await res.json() as Record<string, unknown>; } catch { /* fica {} */ }

  return { ok: res.ok, status: res.status, json };
}

function caminhar(obj: unknown, caminho: string): unknown {
  return caminho.split(".").reduce<unknown>((acc, k) => {
    if (acc && typeof acc === "object" && k in (acc as object)) {
      return (acc as Record<string, unknown>)[k];
    }
    return undefined;
  }, obj);
}

function texto(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  return undefined;
}

/* --------------------------------------------------------------- compra -- */

export async function comprarNaAppmax(p: ParametrosCompra): Promise<ResultadoCompra> {
  /*
   * A Appmax não emite boleto pela API de checkout, e o contrato de cobrança
   * agora prevê o método porque outro gateway emite. Recusar aqui é o que
   * impede a tela de oferecer uma opção que morreria na cobrança.
   */
  if (p.pagamento.metodo === "boleto") {
    return { ok: false, tipo: "erro", motivo: "A Appmax não emite boleto por este checkout." };
  }

  const produtosCents = p.itens.reduce(
    (s, i) => s + i.unitPriceCents * i.quantity, 0,
  );
  const totalEsperado = produtosCents + p.freteCents - (p.descontoCents ?? 0);

  let pedidoId: string | undefined;

  try {
    const token = await obterToken(p.credenciais);
    const { primeiro, ultimo } = partirNome(p.comprador.nome);
    const end = p.comprador.endereco;

    /* ----------------------------------------------------- 1. cliente -- */
    const cliente = await chamar("/v1/customers", token, {
      first_name: primeiro,
      last_name: ultimo,
      email: p.comprador.email,
      phone: digitos(p.comprador.telefone),
      ip: p.comprador.ip,
      document_number: digitos(p.comprador.documento),
      ...(end ? {
        address: {
          postcode: end.cep ? digitos(end.cep) : undefined,
          street: end.rua,
          number: end.numero,
          complement: end.complemento,
          district: end.bairro,
          city: end.cidade,
          state: end.estado,
        },
      } : {}),
      ...(p.utm ? {
        tracking: { utm_source: p.utm.source, utm_campaign: p.utm.campaign },
      } : {}),
    });

    if (!cliente.ok) {
      return { ok: false, tipo: "erro", motivo: motivoDoErro(cliente.json, cliente.status) };
    }

    const clienteId = texto(caminhar(cliente.json, "data.customer.id"))
      ?? texto(caminhar(cliente.json, "data.id"));
    if (!clienteId) return { ok: false, tipo: "erro", motivo: "Appmax não devolveu customer_id" };

    /* ------------------------------------------------------ 2. pedido -- */
    const pedido = await chamar("/v1/orders", token, {
      customer_id: Number(clienteId),
      products_value: produtosCents,
      discount_value: p.descontoCents ?? 0,
      shipping_value: p.freteCents,
      products: p.itens.map((i) => ({
        sku: i.sku,
        name: i.name,
        quantity: i.quantity,
        unit_value: i.unitPriceCents,
        type: i.digital ? "digital" : "physical",
      })),
    });

    if (!pedido.ok) {
      return { ok: false, tipo: "erro", motivo: motivoDoErro(pedido.json, pedido.status) };
    }

    pedidoId = texto(caminhar(pedido.json, "data.order.id"))
      ?? texto(caminhar(pedido.json, "data.id"));
    if (!pedidoId) return { ok: false, tipo: "erro", motivo: "Appmax não devolveu order_id" };

    /* ----------------------------------------- 3. confere antes de cobrar */
    const divergencia = await conferirTotal(pedidoId, token, totalEsperado);
    if (divergencia) {
      return { ok: false, tipo: "erro", motivo: divergencia, gatewayOrderId: pedidoId };
    }

    /* ------------------------------------------------------ 4. cobrança -- */
    const cobranca = p.pagamento.metodo === "pix"
      ? await chamar("/v1/payments/pix", token, {
          order_id: Number(pedidoId),
          payment_data: { pix: { document_number: digitos(p.comprador.documento) } },
        })
      : await chamar("/v1/payments/credit-card", token, {
          order_id: Number(pedidoId),
          customer_id: Number(clienteId),
          payment_data: {
            credit_card: {
              token: p.pagamento.token,
              holder_name: p.pagamento.titular,
              holder_document_number: digitos(p.pagamento.documentoTitular),
              installments: p.pagamento.parcelas,
              ...(p.pagamento.softDescriptor
                ? { soft_descriptor: p.pagamento.softDescriptor } : {}),
            },
          },
        });

    if (!cobranca.ok) {
      /*
       * 422 é regra de negócio — cartão recusado, antifraude, limite. O
       * comprador pode tentar outro cartão. 4xx restante e 5xx são falha
       * técnica, e mandar "cartão recusado" nesse caso faria a pessoa culpar
       * um cartão que está bom.
       */
      const recusa = cobranca.status === 422 || cobranca.status === 402;
      return {
        ok: false,
        tipo: recusa ? "recusado" : "erro",
        motivo: motivoDoErro(cobranca.json, cobranca.status),
        gatewayOrderId: pedidoId,
      };
    }

    if (p.pagamento.metodo === "pix") {
      const pix = caminhar(cobranca.json, "data.payment") ?? caminhar(cobranca.json, "data");
      return {
        ok: true,
        gatewayOrderId: pedidoId,
        estado: "pending",
        pix: {
          qrcodeBase64: texto(caminhar(pix, "pix_qrcode")),
          emv: texto(caminhar(pix, "pix_emv")),
          expiraEm: texto(caminhar(pix, "pix_expiration_date")),
        },
      };
    }

    /*
     * Cartão aprovado aqui é "autorizado", não "aprovado": a Appmax ainda passa
     * pelo antifraude e só então manda `order_approved`. Quem confirma a venda
     * é o webhook — esta resposta serve para tirar o comprador da tela de
     * pagamento, não para contar faturamento.
     */
    return { ok: true, gatewayOrderId: pedidoId, estado: "pending" };
  } catch (e) {
    return {
      ok: false,
      tipo: "erro",
      motivo: e instanceof Error ? e.message : "falha ao falar com a Appmax",
      gatewayOrderId: pedidoId,
    };
  }
}

/*
 * Lê o pedido de volta e compara o total com o que pretendíamos cobrar.
 *
 * Devolve `null` quando está tudo certo, ou a mensagem do problema. Não é
 * paranoia genérica: é a única defesa contra a unidade monetária ser diferente
 * do que supomos, e contra a Appmax recalcular o total por conta própria (frete
 * por faixa, arredondamento de parcela). Nos dois casos o pedido já existe mas
 * ainda não foi cobrado, que é exatamente a janela em que dá para desistir.
 *
 * Se a consulta falhar, seguimos. Recusar a venda porque uma conferência não
 * respondeu seria trocar um risco raro por uma perda certa.
 */
async function conferirTotal(
  pedidoId: string,
  token: string,
  esperado: number,
): Promise<string | null> {
  try {
    const res = await fetch(`${API}/v1/orders/${pedidoId}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!res.ok) return null;

    const j = await res.json() as Record<string, unknown>;
    const d = (caminhar(j, "data.order") ?? caminhar(j, "data") ?? j) as Record<string, unknown>;

    const bruto = d.total ?? d.total_value ?? d.total_paid;
    if (bruto === undefined || bruto === null) return null;

    const cobrado = typeof bruto === "number"
      ? (Number.isInteger(bruto) ? bruto : Math.round(bruto * 100))
      : Math.round(parseFloat(String(bruto).replace(",", ".")) * 100);

    if (!Number.isFinite(cobrado)) return null;

    /*
     * Um centavo de diferença é arredondamento de parcela e não interessa. Já
     * uma diferença grande significa que a Appmax entendeu outro valor — é aí
     * que a cobrança precisa não acontecer.
     */
    if (Math.abs(cobrado - esperado) <= 1) return null;

    const reais = (c: number) => "R$ " + (c / 100).toFixed(2).replace(".", ",");
    return `valor divergente: pedido criado com ${reais(cobrado)}, esperado ${reais(esperado)}`;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ cobrador -- */

/*
 * A Appmax como uma das formas de cobrar, não como A forma.
 *
 * Declarar `metodos` aqui é o que faz a tela oferecer só o que este gateway
 * sabe fazer: sem isso, o comprador escolheria boleto numa conexão Appmax e
 * descobriria o problema depois de preencher o formulário inteiro.
 */
export const cobradorAppmax: CobradorCheckout = {
  id: "appmax",
  rotulo: "Appmax",
  metodos: ["pix", "credit_card"],
  tokenizacao: { tipo: "api", url: TOKENIZE },
  cobrar: comprarNaAppmax,
};
