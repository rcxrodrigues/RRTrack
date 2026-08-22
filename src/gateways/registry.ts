import type { GatewayAdapter } from "./types";
import { pagouAdapter } from "./pagou";

/* Plugar um gateway novo é escrever o adaptador e acrescentar uma linha aqui. */
const adapters: GatewayAdapter[] = [pagouAdapter];

const byId = new Map(adapters.map((a) => [a.id, a]));

export function getGateway(id: string): GatewayAdapter | undefined {
  return byId.get(id);
}

export function listGateways(): GatewayAdapter[] {
  return [...adapters];
}
