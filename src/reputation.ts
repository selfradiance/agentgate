import type { IdentityStats, ResolveOutcome } from "./types";

export function scoreIdentity(stats: IdentityStats): number {
  return stats.locks * 2 + stats.actions * 3 + stats.successes * 10 - stats.failures * 5 - stats.malicious * 20;
}

export type TrustTier = 1 | 2 | 3;

export function computeTrustTier(
  history: ResolveOutcome[],
  banned: boolean = false,
): TrustTier {
  if (banned) return 1;

  const hasMalicious = history.some((h) => h === "malicious");
  if (hasMalicious) return 1;

  const successes = history.filter((h) => h === "success").length;

  if (successes >= 20) return 3;
  if (successes >= 5) return 2;
  return 1;
}
