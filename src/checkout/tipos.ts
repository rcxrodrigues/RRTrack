/*
 * O contrato que todo gateway cumpre para cobrar pelo nosso checkout.
 *
 * Estes tipos moravam dentro do driver da Appmax, o que era honesto enquanto
 * ela era o único jeito de cobrar — e virou mentira no instante em que passou
 * a haver um segundo. Tipo compartilhado morando dentro de uma implementação é
 * como o resto do sistema aprende a depender dela sem ninguém decidir isso.
 *
 * A fronteira é a mesma ideia de `src/core/types.ts`, do outro lado do fluxo:
 * lá nenhum campo específico de gateway atravessa para dentro; aqui nenhum
 * atravessa para fora. O que muda entre Appmax, pagou.ai e MillionsPay é a
 * ordem das chamadas, o nome dos campos e o formato do token do cartão — nada
 * disso pode aparecer em `index.ts`, que é onde mora o preço.
 */

import type { GatewayCredentials } from "../gateways/types";

export interface CompradorCheckout {
  nome: string;
  email: string;
  telefone: string;
  /** CPF, só dígitos ou formatado — os gateways aceitam os dois. */
  documento: string;
  /** IP do comprador. Os antifraudes exigem, e não é opcional na prática. */
  ip: string;
  endereco?: {
    cep?: string;
    rua?: string;
    numero?: string;
    complemento?: string;
    bairro?: string;
    cidade?: string;
    estado?: string;
  };
}

export interface ItemCobrado {
  sku: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  digital?: boolean;
}

export type MetodoPagamento = "pix" | "credit_card" | "boleto";

export type PagamentoPedido =
  | { metodo: "pix" }
  | { metodo: "boleto" }
  | {
      metodo: "credit_card";
      /** Token gerado no navegador. Nunca o número do cartão. */
      token: string;
      titular: string;
      documentoTitular: string;
      parcelas: number;
      softDescriptor?: string;
    };

export interface DadosPix {
  /** PNG em base64, sem o prefixo `data:`. */
  qrcodeBase64?: string;
  /** BR Code copia-e-cola. */
  emv?: string;
  expiraEm?: string;
}

export interface DadosBoleto {
  linhaDigitavel?: string;
  url?: string;
  venceEm?: string;
}

export type ResultadoCompra =
  | {
      ok: true;
      gatewayOrderId: string;
      /* "pending" cobre pix aguardando, boleto emitido e cartão em análise. */
      estado: "pending" | "paid";
      pix?: DadosPix;
      boleto?: DadosBoleto;
    }
  | {
      ok: false;
      /* Distinguir importa: recusa é decisão do gateway e não se repete
         sozinha; erro é falha técnica e pode valer nova tentativa. */
      tipo: "recusado" | "erro";
      motivo: string;
      /* Pode existir mesmo em recusa — o pedido foi criado antes da cobrança. */
      gatewayOrderId?: string;
    };

export interface ParametrosCompra {
  credenciais: GatewayCredentials;
  comprador: CompradorCheckout;
  itens: ItemCobrado[];
  freteCents: number;
  descontoCents?: number;
  pagamento: PagamentoPedido;
  /* Repassado ao gateway como origem da venda; não volta no webhook. */
  utm?: { source?: string; campaign?: string };
}

/*
 * Como o navegador troca o cartão por um token.
 *
 * É a parte que decide o regime de PCI da operação inteira, e por isso é
 * declarada aqui em vez de ficar implícita no formulário: com tokenização, o
 * número do cartão vai do navegador direto para o gateway e o nosso servidor
 * nunca o vê — SAQ-A, o questionário mais simples. Sem ela, o número
 * atravessaria a nossa infraestrutura e o regime vira o completo, com varredura
 * trimestral e auditoria.
 *
 * `api` é o caso da Appmax: o navegador faz um POST direto para um endereço
 * dela e recebe o token de volta. `script` é o caso mais comum no mercado — o
 * gateway publica um JS que a página carrega e que devolve o token; vale
 * preferi-lo quando existe, porque o formato do corpo passa a ser problema de
 * quem o publica. `nenhuma` marca gateway que só cobra pix ou boleto, onde não
 * há cartão para proteger.
 */
export type Tokenizacao =
  | { tipo: "api"; url: string }
  | { tipo: "script"; url: string; global: string }
  | { tipo: "nenhuma" };

/*
 * Um jeito de cobrar.
 *
 * `id` casa com `gateway_connections.gateway`, que é como o checkout descobre
 * qual driver usar a partir da conexão que o lojista escolheu — sem `if` por
 * nome de gateway espalhado pelo caminho do pagamento.
 */
export interface CobradorCheckout {
  id: string;
  rotulo: string;
  /** O que este gateway sabe cobrar. A tela só oferece o que está aqui. */
  metodos: MetodoPagamento[];
  tokenizacao: Tokenizacao;
  cobrar(p: ParametrosCompra): Promise<ResultadoCompra>;
}
