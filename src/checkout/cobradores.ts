/*
 * Quem sabe cobrar, e por qual gateway.
 *
 * O checkout escolhia a Appmax porque estava escrito "appmax" no meio do
 * caminho do pagamento, em três lugares diferentes. Isso funcionava e era
 * frágil pelo motivo de sempre: trocar de gateway — ou usar dois, um por
 * oferta — exigiria caçar cada um desses lugares, e esquecer um não daria erro
 * de compilação, daria cobrança pelo gateway errado.
 *
 * Agora a conexão que o lojista escolheu diz o gateway, e o gateway diz o
 * cobrador. `index.ts` não menciona nenhum nome de gateway.
 *
 * ---------------------------------------------------------------------------
 * PARA ADICIONAR UM GATEWAY
 *
 * Um arquivo irmão deste, exportando um `CobradorCheckout`, e uma linha na
 * lista abaixo. O que ele precisa saber fazer é criar a cobrança e devolver
 * `gatewayOrderId` — a confirmação continua chegando pelo webhook, que já
 * existe para todos eles em `src/gateways/`.
 *
 * O que NÃO dá para escrever sem a documentação de cobrança de cada um: a
 * ordem das chamadas, os nomes dos campos e, principalmente, como o cartão é
 * tokenizado no navegador. Adaptador escrito por suposição já custou três
 * correções neste projeto — em todas, o teste passava porque testava a minha
 * suposição contra ela mesma. Então: com a documentação na mão, não antes.
 * ---------------------------------------------------------------------------
 */

import { cobradorAppmax } from "./appmax";
import type { CobradorCheckout, MetodoPagamento } from "./tipos";

const LISTA: CobradorCheckout[] = [
  cobradorAppmax,
];

const POR_ID = new Map(LISTA.map((c) => [c.id, c]));

/** O cobrador de um gateway, ou nada — nem todo gateway integrado sabe cobrar. */
export function cobradorDe(gateway: string): CobradorCheckout | undefined {
  return POR_ID.get(gateway);
}

/** Os gateways que podem ficar atrás de um checkout próprio. */
export function gatewaysQueCobram(): Array<{ id: string; rotulo: string; metodos: MetodoPagamento[] }> {
  return LISTA.map((c) => ({ id: c.id, rotulo: c.rotulo, metodos: c.metodos }));
}

/*
 * O que a página pública precisa saber para montar o formulário: quais meios
 * oferecer e para onde mandar o cartão. Nunca inclui credencial — isto vai
 * para o navegador.
 */
export function formaDeCobrar(gateway: string): {
  rotulo: string;
  metodos: MetodoPagamento[];
  tokenizacao: CobradorCheckout["tokenizacao"];
} | null {
  const c = POR_ID.get(gateway);
  if (!c) return null;
  return { rotulo: c.rotulo, metodos: c.metodos, tokenizacao: c.tokenizacao };
}
