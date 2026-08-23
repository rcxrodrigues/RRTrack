import type { AdSpendAdapter } from "./types";
import { metaAdsAdapter } from "./meta";

/* Google, TikTok, Kwai e Taboola entram aqui, um arquivo cada. */
const adapters: AdSpendAdapter[] = [metaAdsAdapter];

const porPlataforma = new Map(adapters.map((a) => [a.platform, a]));

export function getAdSpend(plataforma: string): AdSpendAdapter | undefined {
  return porPlataforma.get(plataforma);
}

export function listAdSpend(): AdSpendAdapter[] {
  return [...adapters];
}
