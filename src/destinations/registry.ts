import type { DestinationAdapter } from "./types";
import { metaAdapter } from "./meta";
import { tiktokAdapter } from "./tiktok";
import { googleAdapter } from "./google";
import { ga4Adapter } from "./ga4";

const adapters: DestinationAdapter[] = [metaAdapter, tiktokAdapter, googleAdapter, ga4Adapter];

const byPlatform = new Map(adapters.map((a) => [a.platform, a]));

export function getDestination(platform: string): DestinationAdapter | undefined {
  return byPlatform.get(platform);
}

