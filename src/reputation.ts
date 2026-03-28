import type { IdentityStats, ResolveOutcome } from "./types";

export function scoreIdentity(stats: IdentityStats): number {
  return stats.locks * 2 + stats.actions * 3 + stats.successes * 10 - stats.failures * 5 - stats.malicious * 20;
}

export type TrustTier = 1 | 2 | 3;

export interface TrustHistoryEntry {
  outcome: ResolveOutcome;
  exposureCents: number;
  resolvedByIdentityId: string | null;
}

export const MIN_TRUST_TIER_SUCCESS_EXPOSURE_CENTS = 100;
export const TIER_2_QUALIFYING_SUCCESSES = 5;
export const TIER_3_QUALIFYING_SUCCESSES = 20;

type TrustHistoryInput = ResolveOutcome | TrustHistoryEntry;

function normalizeHistoryEntry(entry: TrustHistoryInput, index: number): TrustHistoryEntry {
  if (typeof entry === "string") {
    return {
      outcome: entry,
      exposureCents: entry === "success" ? MIN_TRUST_TIER_SUCCESS_EXPOSURE_CENTS : 0,
      resolvedByIdentityId: entry === "success" ? `legacy-resolver-${index}` : null,
    };
  }

  return {
    outcome: entry.outcome,
    exposureCents: Math.max(0, Math.trunc(entry.exposureCents)),
    resolvedByIdentityId: entry.resolvedByIdentityId ?? null,
  };
}

function getQualifyingSuccesses(history: TrustHistoryEntry[]) {
  return history.filter(
    (entry) =>
      entry.outcome === "success" &&
      entry.exposureCents >= MIN_TRUST_TIER_SUCCESS_EXPOSURE_CENTS &&
      entry.resolvedByIdentityId !== null,
  );
}

export function computeTrustTier(history: TrustHistoryInput[]): TrustTier {
  const normalizedHistory = history.map((entry, index) => normalizeHistoryEntry(entry, index));

  const hasMalicious = normalizedHistory.some((entry) => entry.outcome === "malicious");
  if (hasMalicious) return 1;

  const qualifyingSuccesses = getQualifyingSuccesses(normalizedHistory);
  const independentResolvers = new Set(
    qualifyingSuccesses.map((entry) => entry.resolvedByIdentityId),
  );

  if (
    qualifyingSuccesses.length >= TIER_3_QUALIFYING_SUCCESSES &&
    independentResolvers.size >= TIER_3_QUALIFYING_SUCCESSES
  ) {
    return 3;
  }
  if (
    qualifyingSuccesses.length >= TIER_2_QUALIFYING_SUCCESSES &&
    independentResolvers.size >= TIER_2_QUALIFYING_SUCCESSES
  ) {
    return 2;
  }
  return 1;
}
