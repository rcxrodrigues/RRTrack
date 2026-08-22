import type { DestinationAdapter } from "./types";
import { metaAdapter } from "./meta";

const adapters: DestinationAdapter[] = [metaAdapter];

const byPlatform = new Map(adapters.map((a) => [a.platform, a]));

export function getDestination(platform: string): DestinationAdapter | undefined {
  return byPlatform.get(platform);
}

export function listDestinations(): DestinationAdapter[] {
  return [...adapters];
}
