import type { IdentityStats } from "./types";

export function scoreIdentity(stats: IdentityStats): number {
  return (
    stats.locks * 2 +
    stats.offers * 3 +
    stats.accepts * 10 +
    stats.rejects -
    stats.expires * 5 -
    stats.slashes * 20
  );
}
