import type { AdSpendAdapter } from "./types";
import { metaAdsAdapter } from "./meta";
import { tiktokAdsAdapter } from "./tiktok";

/* Google entra aqui quando o token de desenvolvedor for aprovado. */
const adapters: AdSpendAdapter[] = [metaAdsAdapter, tiktokAdsAdapter];

const porPlataforma = new Map(adapters.map((a) => [a.platform, a]));

export function getAdSpend(plataforma: string): AdSpendAdapter | undefined {
  return porPlataforma.get(plataforma);
}

export function listAdSpend(): AdSpendAdapter[] {
  return [...adapters];
}
