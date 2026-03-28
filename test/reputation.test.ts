import { describe, it, expect } from "vitest";
import { computeTrustTier } from "../src/reputation";
import type { ResolveOutcome } from "../src/types";

function makeHistory(successes: number, failed: number = 0, malicious: number = 0): ResolveOutcome[] {
  return [
    ...Array<ResolveOutcome>(successes).fill("success"),
    ...Array<ResolveOutcome>(failed).fill("failed"),
    ...Array<ResolveOutcome>(malicious).fill("malicious"),
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

  it("banned identity stays Tier 1 regardless of successes", () => {
    expect(computeTrustTier(makeHistory(30), true)).toBe(1);
  });
});
