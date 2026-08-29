import type { GatewayAdapter } from "./types";
import { pagouAdapter } from "./pagou";
import { appmaxAdapter } from "./appmax";
import { millionsAdapter } from "./millions";
import { shopifyAdapter } from "./shopify";
import { gatewayGenericoAdapter, genericoAdapter, webhookGenericoAdapter } from "./generico";

/* Plugar um gateway novo é escrever o adaptador e acrescentar uma linha aqui. */
const adapters: GatewayAdapter[] = [
  pagouAdapter, appmaxAdapter, millionsAdapter, shopifyAdapter,
  /* Últimos de propósito: são os coringas, não a primeira escolha. */
  webhookGenericoAdapter, gatewayGenericoAdapter,
  genericoAdapter,
];

const byId = new Map(adapters.map((a) => [a.id, a]));

export function getGateway(id: string): GatewayAdapter | undefined {
  return byId.get(id);
}

export function listGateways(): GatewayAdapter[] {
  return [...adapters];
}
