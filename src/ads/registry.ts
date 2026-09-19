import type { AdSpendAdapter } from "./types";
import { metaAdsAdapter } from "./meta";
import { tiktokAdsAdapter } from "./tiktok";
import { googleAdsAdapter } from "./google";

const adapters: AdSpendAdapter[] = [metaAdsAdapter, tiktokAdsAdapter, googleAdsAdapter];

const porPlataforma = new Map(adapters.map((a) => [a.platform, a]));

export function getAdSpend(plataforma: string): AdSpendAdapter | undefined {
  return porPlataforma.get(plataforma);
}

