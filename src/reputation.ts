import type { IdentityStats } from "./types";

export function scoreIdentity(stats: IdentityStats): number {
  return stats.locks * 2 + stats.actions * 3 + stats.successes * 10 - stats.failures * 5 - stats.malicious * 20;
}
