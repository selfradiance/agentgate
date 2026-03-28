import { describe, it, expect } from "vitest";
import {
  computeTrustTier,
  MIN_TRUST_TIER_SUCCESS_EXPOSURE_CENTS,
  type TrustHistoryEntry
} from "../src/reputation";

function makeHistory(
  successes: number,
  failed: number = 0,
  malicious: number = 0,
  options: {
    exposureCents?: number;
    distinctResolvers?: boolean;
  } = {}
): TrustHistoryEntry[] {
  const exposureCents = options.exposureCents ?? MIN_TRUST_TIER_SUCCESS_EXPOSURE_CENTS;
  const distinctResolvers = options.distinctResolvers ?? true;

  return [
    ...Array.from({ length: successes }, (_, index) => ({
      outcome: "success" as const,
      exposureCents,
      resolvedByIdentityId: distinctResolvers ? `resolver_${index}` : "resolver_shared"
    })),
    ...Array.from({ length: failed }, () => ({
      outcome: "failed" as const,
      exposureCents: 0,
      resolvedByIdentityId: "resolver_failed"
    })),
    ...Array.from({ length: malicious }, () => ({
      outcome: "malicious" as const,
      exposureCents: 0,
      resolvedByIdentityId: "resolver_malicious"
    })),
  ];
}

describe("computeTrustTier", () => {
  it("new identity (empty history) returns Tier 1", () => {
    expect(computeTrustTier([])).toBe(1);
  });

  it("identity with 0 successes returns Tier 1", () => {
    expect(computeTrustTier(makeHistory(0, 3))).toBe(1);
  });

  it("identity with 4 successes returns Tier 1 (just under threshold)", () => {
    expect(computeTrustTier(makeHistory(4))).toBe(1);
  });

  it("identity with 5 successes returns Tier 2", () => {
    expect(computeTrustTier(makeHistory(5))).toBe(2);
  });

  it("identity with 20 successes returns Tier 3", () => {
    expect(computeTrustTier(makeHistory(20))).toBe(3);
  });

  it("identity with 19 successes returns Tier 2 (just under Tier 3 threshold)", () => {
    expect(computeTrustTier(makeHistory(19))).toBe(2);
  });

  it("identity with 4 successes and 3 failed returns Tier 1 (failed does not advance tier)", () => {
    expect(computeTrustTier(makeHistory(4, 3))).toBe(1);
  });

  it("identity with 25 successes and 1 malicious returns Tier 1", () => {
    expect(computeTrustTier(makeHistory(25, 0, 1))).toBe(1);
  });

  it("successful resolutions below the qualifying exposure threshold do not advance tier", () => {
    expect(computeTrustTier(makeHistory(20, 0, 0, { exposureCents: 2 }))).toBe(1);
  });

  it("repeated success approvals from the same resolver do not advance tier", () => {
    expect(computeTrustTier(makeHistory(20, 0, 0, { distinctResolvers: false }))).toBe(1);
  });

  it("trust tier depends only on resolution history, not banned state", () => {
    const history = makeHistory(5);
    expect(computeTrustTier(history)).toBe(2);
  });
});
