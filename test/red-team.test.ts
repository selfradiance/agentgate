import type Database from "better-sqlite3";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "../src/db";
import { IbpService } from "../src/service";

// ---------------------------------------------------------------------------
// Helper: convert base64url (JWK format) → standard base64
// ---------------------------------------------------------------------------
function fromBase64Url(value: string): string {
  const padded = `${value}${"===".slice((value.length + 3) % 4)}`;
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("base64");
}

// ---------------------------------------------------------------------------
// generatePublicKey — produces a valid base64-encoded Ed25519 public key
// ---------------------------------------------------------------------------
function generatePublicKey(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  if (!jwk.x) throw new Error("Missing Ed25519 public key x component");
  return fromBase64Url(jwk.x);
}

// ---------------------------------------------------------------------------
// validateInvariants
//
// Checks all 8 "laws of physics" for AgentGate's state machine. Throws with a
// descriptive message if any invariant is violated. Call this at the end of
// every red-team test to confirm the system is still in a consistent state.
// ---------------------------------------------------------------------------
export function validateInvariants(db: Database.Database): void {
  // 1. bond.amount_cents >= 0 — a bond can never go negative
  const inv1 = db
    .prepare(`SELECT id, amount_cents FROM bonds WHERE amount_cents < 0`)
    .all() as Array<{ id: string; amount_cents: number }>;
  if (inv1.length > 0) {
    throw new Error(
      `Invariant 1 violated — bonds with negative amount_cents: ${JSON.stringify(inv1)}`
    );
  }

  // 2. bond.outstanding_exposure_cents >= 0 — outstanding exposure can never go negative
  const inv2 = db
    .prepare(
      `SELECT id, outstanding_exposure_cents FROM bonds WHERE outstanding_exposure_cents < 0`
    )
    .all() as Array<{ id: string; outstanding_exposure_cents: number }>;
  if (inv2.length > 0) {
    throw new Error(
      `Invariant 2 violated — bonds with negative outstanding_exposure_cents: ${JSON.stringify(inv2)}`
    );
  }

  // 3. outstanding_exposure_cents <= amount_cents — you can't owe more than you posted
  const inv3 = db
    .prepare(
      `SELECT id, amount_cents, outstanding_exposure_cents
       FROM bonds
       WHERE outstanding_exposure_cents > amount_cents`
    )
    .all() as Array<{ id: string; amount_cents: number; outstanding_exposure_cents: number }>;
  if (inv3.length > 0) {
    throw new Error(
      `Invariant 3 violated — bonds where outstanding_exposure_cents > amount_cents: ${JSON.stringify(inv3)}`
    );
  }

  // 4. Every open action must reference a bond with status 'active' or 'occupied'
  const inv4 = db
    .prepare(
      `SELECT a.id AS action_id, a.bond_id, b.status AS bond_status
       FROM actions a
       LEFT JOIN bonds b ON a.bond_id = b.id
       WHERE a.status = 'open'
         AND (b.id IS NULL OR b.status NOT IN ('active', 'occupied'))`
    )
    .all() as Array<{ action_id: string; bond_id: string; bond_status: string | null }>;
  if (inv4.length > 0) {
    throw new Error(
      `Invariant 4 violated — open actions referencing non-active/occupied bonds: ${JSON.stringify(inv4)}`
    );
  }

  // 5. Bonds with status 'released' or 'burned' must have outstanding_exposure_cents = 0
  //    (resolveAction sets outstanding_exposure_cents = 0 on success/failed resolution)
  const inv5 = db
    .prepare(
      `SELECT id, status, outstanding_exposure_cents
       FROM bonds
       WHERE status IN ('released', 'burned')
         AND outstanding_exposure_cents != 0`
    )
    .all() as Array<{ id: string; status: string; outstanding_exposure_cents: number }>;
  if (inv5.length > 0) {
    throw new Error(
      `Invariant 5 violated — released/burned bonds with non-zero outstanding_exposure_cents: ${JSON.stringify(inv5)}`
    );
  }

  // 6. Every action with status 'malicious' must have its bond status = 'slashed'
  //    AND the bond's slashed_cents must be > 0 (the slash was persisted)
  const inv6 = db
    .prepare(
      `SELECT a.id AS action_id, b.id AS bond_id, b.status AS bond_status, b.slashed_cents
       FROM actions a
       JOIN bonds b ON a.bond_id = b.id
       WHERE a.status = 'malicious'
         AND (b.status != 'slashed' OR b.slashed_cents <= 0)`
    )
    .all() as Array<{ action_id: string; bond_id: string; bond_status: string; slashed_cents: number }>;
  if (inv6.length > 0) {
    throw new Error(
      `Invariant 6 violated — malicious actions whose bond is not slashed or has zero slashed_cents: ${JSON.stringify(inv6)}`
    );
  }

  // 7. Sum of all open actions' exposure_cents for a bond == bond.outstanding_exposure_cents
  const inv7 = db
    .prepare(
      `SELECT b.id AS bond_id,
              b.outstanding_exposure_cents,
              COALESCE(SUM(a.exposure_cents), 0) AS open_exposure_sum
       FROM bonds b
       LEFT JOIN actions a ON a.bond_id = b.id AND a.status = 'open'
       GROUP BY b.id
       HAVING b.outstanding_exposure_cents != open_exposure_sum`
    )
    .all() as Array<{
      bond_id: string;
      outstanding_exposure_cents: number;
      open_exposure_sum: number;
    }>;
  if (inv7.length > 0) {
    throw new Error(
      `Invariant 7 violated — bond outstanding_exposure_cents does not match sum of open action exposures: ${JSON.stringify(inv7)}`
    );
  }

  // 8. No two nonce entries share the same (nonce, identity_id) pair
  //    (enforced by composite PK in the schema, but we assert it explicitly)
  const inv8 = db
    .prepare(
      `SELECT nonce, identity_id, COUNT(*) AS cnt
       FROM nonces
       GROUP BY nonce, identity_id
       HAVING cnt > 1`
    )
    .all() as Array<{ nonce: string; identity_id: string; cnt: number }>;
  if (inv8.length > 0) {
    throw new Error(
      `Invariant 8 violated — duplicate (nonce, identity_id) pairs in nonces table: ${JSON.stringify(inv8)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Attack 1.1 — over-commit exposure beyond bond capacity", () => {
  const handles: DatabaseHandle[] = [];

  afterEach(() => {
    while (handles.length > 0) {
      handles.pop()?.close();
    }
  });

  function buildDb(): DatabaseHandle {
    const handle = createDatabase(":memory:");
    handles.push(handle);
    return handle;
  }

  it("rejects an action whose effective exposure would exceed the bond's remaining capacity", async () => {
    const handle = buildDb();
    const service = new IbpService(handle.db);

    const { identityId } = service.createIdentity({ publicKey: generatePublicKey() });
    const { bondId } = service.lockBond({
      identityId,
      amountCents: 1000,
      currency: "USD",
      ttlSeconds: 300,
      reason: "attack-1.1",
    });

    // Action 1: declared 400 → effective ceil(400 × 1.2) = 480. Outstanding becomes 480, 520 remaining.
    await service.executeAction({
      identityId,
      bondId,
      actionType: "attack-1.1-first",
      exposure_cents: 400,
    });

    // Action 2: declared 450 → effective ceil(450 × 1.2) = 540. Combined: 480 + 540 = 1020 > 1000.
    // Must be rejected before any state change occurs.
    await expect(
      service.executeAction({
        identityId,
        bondId,
        actionType: "attack-1.1-second",
        exposure_cents: 450,
      })
    ).rejects.toMatchObject({ code: "INSUFFICIENT_BOND_CAPACITY" });

    // Bond state must be unchanged by the rejected action — still 480 outstanding, not 1020.
    const bond = handle.db
      .prepare(`SELECT outstanding_exposure_cents FROM bonds WHERE id = ?`)
      .get(bondId) as { outstanding_exposure_cents: number };
    expect(bond.outstanding_exposure_cents).toBe(480);

    // All 8 invariants must hold.
    validateInvariants(handle.db);
  });
});

describe("Attack 1.2 — rapid resolve-then-execute cycle", () => {
  const handles: DatabaseHandle[] = [];

  afterEach(() => {
    while (handles.length > 0) {
      handles.pop()?.close();
    }
  });

  function buildDb(): DatabaseHandle {
    const handle = createDatabase(":memory:");
    handles.push(handle);
    return handle;
  }

  it("fully releases exposure on each resolve with no leak or double-release across 5 cycles", async () => {
    const handle = buildDb();
    const service = new IbpService(handle.db);

    const { identityId } = service.createIdentity({ publicKey: generatePublicKey() });

    // Note: resolveAction sets bond.status = 'released' on success, and assertBondCanBackAction
    // rejects any bond that isn't 'active'. The current implementation is therefore one-action-
    // per-bond. Each cycle uses a fresh bond to simulate the rapid execute→resolve→execute pattern.
    for (let cycle = 0; cycle < 5; cycle++) {
      const { bondId } = service.lockBond({
        identityId,
        amountCents: 1000,
        currency: "USD",
        ttlSeconds: 300,
        reason: `attack-1.2-cycle-${cycle}`,
      });

      // Execute: declared 800 → effective ceil(800 × 1.2) = 960
      const { actionId } = await service.executeAction({
        identityId,
        bondId,
        actionType: "attack-1.2",
        exposure_cents: 800,
      });

      // Exposure must be reserved correctly before resolve
      const afterExecute = handle.db
        .prepare(`SELECT outstanding_exposure_cents FROM bonds WHERE id = ?`)
        .get(bondId) as { outstanding_exposure_cents: number };
      expect(afterExecute.outstanding_exposure_cents).toBe(960);

      // Resolve as success — exposure must be fully released, not partially or doubly
      service.resolveAction(actionId, { outcome: "success" });

      const afterResolve = handle.db
        .prepare(`SELECT outstanding_exposure_cents FROM bonds WHERE id = ?`)
        .get(bondId) as { outstanding_exposure_cents: number };
      expect(afterResolve.outstanding_exposure_cents).toBe(0);
    }

    // All 8 invariants must hold after all 5 cycles
    validateInvariants(handle.db);
  });
});

describe("Attack 1.3 — resolve an already-resolved action", () => {
  const handles: DatabaseHandle[] = [];

  afterEach(() => {
    while (handles.length > 0) {
      handles.pop()?.close();
    }
  });

  function buildDb(): DatabaseHandle {
    const handle = createDatabase(":memory:");
    handles.push(handle);
    return handle;
  }

  it("rejects a second resolve on an already-settled action", async () => {
    const handle = buildDb();
    const service = new IbpService(handle.db);

    const { identityId } = service.createIdentity({ publicKey: generatePublicKey() });
    const { bondId } = service.lockBond({
      identityId,
      amountCents: 1000,
      currency: "USD",
      ttlSeconds: 300,
      reason: "attack-1.3",
    });

    const { actionId } = await service.executeAction({
      identityId,
      bondId,
      actionType: "attack-1.3",
      exposure_cents: 500,
    });

    // First resolve: success — this is the legitimate settlement
    service.resolveAction(actionId, { outcome: "success" });

    const afterFirstResolve = handle.db
      .prepare(`SELECT status, slashed_cents FROM bonds WHERE id = ?`)
      .get(bondId) as { status: string; slashed_cents: number };
    expect(afterFirstResolve.status).toBe("released");
    expect(afterFirstResolve.slashed_cents).toBe(0);

    // Second resolve: malicious — must be rejected; the action is already settled
    // If this succeeds, an already-released bond would be re-slashed, corrupting state.
    expect(() =>
      service.resolveAction(actionId, { outcome: "malicious" })
    ).toThrow();

    // Bond must still be 'released' with zero slashed_cents — not re-slashed
    const afterSecondResolve = handle.db
      .prepare(`SELECT status, slashed_cents FROM bonds WHERE id = ?`)
      .get(bondId) as { status: string; slashed_cents: number };
    expect(afterSecondResolve.status).toBe("released");
    expect(afterSecondResolve.slashed_cents).toBe(0);

    validateInvariants(handle.db);
  });
});

describe("Attack 1.4 — execute against a burned/slashed bond", () => {
  const handles: DatabaseHandle[] = [];

  afterEach(() => {
    while (handles.length > 0) {
      handles.pop()?.close();
    }
  });

  function buildDb(): DatabaseHandle {
    const handle = createDatabase(":memory:");
    handles.push(handle);
    return handle;
  }

  it("rejects a new execute against a bond that has been slashed", async () => {
    const handle = buildDb();
    const service = new IbpService(handle.db);

    const { identityId } = service.createIdentity({ publicKey: generatePublicKey() });
    const { bondId } = service.lockBond({
      identityId,
      amountCents: 1000,
      currency: "USD",
      ttlSeconds: 300,
      reason: "attack-1.4",
    });

    const { actionId } = await service.executeAction({
      identityId,
      bondId,
      actionType: "attack-1.4-first",
      exposure_cents: 500,
    });

    // Resolve as malicious — bond status becomes 'slashed'
    service.resolveAction(actionId, { outcome: "malicious" });

    const afterSlash = handle.db
      .prepare(`SELECT status, slashed_cents FROM bonds WHERE id = ?`)
      .get(bondId) as { status: string; slashed_cents: number };
    expect(afterSlash.status).toBe("slashed");
    expect(afterSlash.slashed_cents).toBeGreaterThan(0);

    // Attempt a second execute against the now-slashed bond — must be rejected
    await expect(
      service.executeAction({
        identityId,
        bondId,
        actionType: "attack-1.4-second",
        exposure_cents: 100,
      })
    ).rejects.toMatchObject({ code: "BOND_NOT_ACTIVE" });

    // No new action should have been recorded for the second attempt
    const openActions = handle.db
      .prepare(`SELECT id FROM actions WHERE bond_id = ? AND status = 'open'`)
      .all(bondId) as Array<{ id: string }>;
    expect(openActions).toHaveLength(0);

    validateInvariants(handle.db);
  });
});

describe("Attack 1.5A — zero exposure declaration", () => {
  const handles: DatabaseHandle[] = [];

  afterEach(() => {
    while (handles.length > 0) {
      handles.pop()?.close();
    }
  });

  function buildDb(): DatabaseHandle {
    const handle = createDatabase(":memory:");
    handles.push(handle);
    return handle;
  }

  // Design decision: exposure_cents = 0 is accepted. The effective exposure is
  // ceil(0 × 1.2) = 0, which never exceeds bond capacity. The agent gets a
  // zero-stake action — economically harmless but a valid no-op. We document
  // this behavior rather than reject it, because the real economic stake is
  // the bond itself (already locked), not any single action's declared exposure.
  it("accepts an action with exposure_cents 0 (zero-stake no-op)", async () => {
    const handle = buildDb();
    const service = new IbpService(handle.db);

    const { identityId } = service.createIdentity({ publicKey: generatePublicKey() });
    const { bondId } = service.lockBond({
      identityId,
      amountCents: 1000,
      currency: "USD",
      ttlSeconds: 300,
      reason: "attack-1.5a",
    });

    const { actionId } = await service.executeAction({
      identityId,
      bondId,
      actionType: "attack-1.5a",
      exposure_cents: 0,
    });

    expect(actionId).toBeTruthy();

    // Outstanding exposure must be 0 — no capacity consumed
    const bond = handle.db
      .prepare(`SELECT outstanding_exposure_cents FROM bonds WHERE id = ?`)
      .get(bondId) as { outstanding_exposure_cents: number };
    expect(bond.outstanding_exposure_cents).toBe(0);

    validateInvariants(handle.db);
  });
});

describe("Attack 1.5B — negative exposure declaration", () => {
  const handles: DatabaseHandle[] = [];

  afterEach(() => {
    while (handles.length > 0) {
      handles.pop()?.close();
    }
  });

  function buildDb(): DatabaseHandle {
    const handle = createDatabase(":memory:");
    handles.push(handle);
    return handle;
  }

  it("rejects an action with negative exposure_cents", async () => {
    const handle = buildDb();
    const service = new IbpService(handle.db);

    const { identityId } = service.createIdentity({ publicKey: generatePublicKey() });
    const { bondId } = service.lockBond({
      identityId,
      amountCents: 1000,
      currency: "USD",
      ttlSeconds: 300,
      reason: "attack-1.5b",
    });

    // Negative exposure would make the effective value negative, pass the
    // capacity check, and reduce outstanding_exposure_cents below zero —
    // violating invariant 2. The service must reject it before any state change.
    await expect(
      service.executeAction({
        identityId,
        bondId,
        actionType: "attack-1.5b",
        exposure_cents: -100,
      })
    ).rejects.toMatchObject({ code: "INVALID_EXPOSURE" });

    // Bond must be untouched — still active, zero outstanding
    const bond = handle.db
      .prepare(`SELECT status, outstanding_exposure_cents FROM bonds WHERE id = ?`)
      .get(bondId) as { status: string; outstanding_exposure_cents: number };
    expect(bond.status).toBe("active");
    expect(bond.outstanding_exposure_cents).toBe(0);

    validateInvariants(handle.db);
  });
});

describe("Attack 1.6 — extremely large exposure value", () => {
  const handles: DatabaseHandle[] = [];

  afterEach(() => {
    while (handles.length > 0) {
      handles.pop()?.close();
    }
  });

  function buildDb(): DatabaseHandle {
    const handle = createDatabase(":memory:");
    handles.push(handle);
    return handle;
  }

  it("rejects an action whose exposure_cents is Number.MAX_SAFE_INTEGER", async () => {
    const handle = buildDb();
    const service = new IbpService(handle.db);

    const { identityId } = service.createIdentity({ publicKey: generatePublicKey() });
    const { bondId } = service.lockBond({
      identityId,
      amountCents: 1000,
      currency: "USD",
      ttlSeconds: 300,
      reason: "attack-1.6",
    });

    // The 1.2x multiplier applied to Number.MAX_SAFE_INTEGER pushes the
    // effective exposure well beyond safe integer range. However, even before
    // any overflow concern, the capacity check fires: the effective value
    // (however large) vastly exceeds the 1000-cent bond — so the system
    // must reject it with INSUFFICIENT_BOND_CAPACITY before any state change.
    await expect(
      service.executeAction({
        identityId,
        bondId,
        actionType: "attack-1.6",
        exposure_cents: Number.MAX_SAFE_INTEGER,
      })
    ).rejects.toMatchObject({ code: "INSUFFICIENT_BOND_CAPACITY" });

    // Bond must be untouched — still active, zero outstanding
    const bond = handle.db
      .prepare(`SELECT status, outstanding_exposure_cents FROM bonds WHERE id = ?`)
      .get(bondId) as { status: string; outstanding_exposure_cents: number };
    expect(bond.status).toBe("active");
    expect(bond.outstanding_exposure_cents).toBe(0);

    validateInvariants(handle.db);
  });
});

describe("Attack 2.1 — sweeper runs during active resolve", () => {
  const handles: DatabaseHandle[] = [];

  afterEach(() => {
    vi.useRealTimers();
    while (handles.length > 0) {
      handles.pop()?.close();
    }
  });

  function buildDb(): DatabaseHandle {
    const handle = createDatabase(":memory:");
    handles.push(handle);
    return handle;
  }

  // Ordering A: resolveAction (success) runs first, then the sweeper.
  // The sweeper should find the action already settled and do nothing.
  // Final state: bond = 'released', action = 'success'.
  it("resolve-then-sweep: action is settled as success; sweeper finds nothing to slash", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-04T12:00:00.000Z"));

    const handle = buildDb();
    const service = new IbpService(handle.db);

    const { identityId } = service.createIdentity({ publicKey: generatePublicKey() });
    const { bondId } = service.lockBond({
      identityId,
      amountCents: 1000,
      currency: "USD",
      ttlSeconds: 1,
      reason: "attack-2.1-a",
    });

    const { actionId } = await service.executeAction({
      identityId,
      bondId,
      actionType: "attack-2.1-a",
      exposure_cents: 500,
    });

    // Advance time past the 1-second TTL so the sweeper would target this action
    vi.setSystemTime(new Date("2026-03-04T12:00:02.000Z"));

    // Resolve wins the race
    service.resolveAction(actionId, { outcome: "success" });

    // Sweeper runs after — must find no open expired actions
    const { slashedCount } = service.sweepExpiredActions();
    expect(slashedCount).toBe(0);

    // Bond and action must reflect the success resolution, not a slash
    const bond = handle.db
      .prepare(`SELECT status, slashed_cents FROM bonds WHERE id = ?`)
      .get(bondId) as { status: string; slashed_cents: number };
    expect(bond.status).toBe("released");
    expect(bond.slashed_cents).toBe(0);

    const action = handle.db
      .prepare(`SELECT status FROM actions WHERE id = ?`)
      .get(actionId) as { status: string };
    expect(action.status).toBe("success");

    validateInvariants(handle.db);
  });

  // Ordering B: sweeper runs first, then resolveAction (success) is attempted.
  // The sweeper slashes the action; the subsequent resolve must be rejected.
  // Final state: bond = 'slashed', action = 'malicious'.
  it("sweep-then-resolve: sweeper slashes first; subsequent resolve is rejected as already-settled", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-04T12:00:00.000Z"));

    const handle = buildDb();
    const service = new IbpService(handle.db);

    const { identityId } = service.createIdentity({ publicKey: generatePublicKey() });
    const { bondId } = service.lockBond({
      identityId,
      amountCents: 1000,
      currency: "USD",
      ttlSeconds: 1,
      reason: "attack-2.1-b",
    });

    const { actionId } = await service.executeAction({
      identityId,
      bondId,
      actionType: "attack-2.1-b",
      exposure_cents: 500,
    });

    // Advance time past the 1-second TTL
    vi.setSystemTime(new Date("2026-03-04T12:00:02.000Z"));

    // Sweeper wins the race
    const { slashedCount } = service.sweepExpiredActions();
    expect(slashedCount).toBe(1);

    // Subsequent resolve attempt must be rejected — action is already settled
    expect(() =>
      service.resolveAction(actionId, { outcome: "success" })
    ).toThrow();

    // Bond and action must reflect the slash, not the attempted success resolve
    const bond = handle.db
      .prepare(`SELECT status, slashed_cents FROM bonds WHERE id = ?`)
      .get(bondId) as { status: string; slashed_cents: number };
    expect(bond.status).toBe("slashed");
    expect(bond.slashed_cents).toBeGreaterThan(0);

    const action = handle.db
      .prepare(`SELECT status FROM actions WHERE id = ?`)
      .get(actionId) as { status: string };
    expect(action.status).toBe("malicious");

    validateInvariants(handle.db);
  });
});

describe("Attack 2.2 — sweeper double-slash prevention", () => {
  const handles: DatabaseHandle[] = [];

  afterEach(() => {
    vi.useRealTimers();
    while (handles.length > 0) {
      handles.pop()?.close();
    }
  });

  function buildDb(): DatabaseHandle {
    const handle = createDatabase(":memory:");
    handles.push(handle);
    return handle;
  }

  it("slashes exactly once across two consecutive sweeps; second sweep does nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-04T12:00:00.000Z"));

    const handle = buildDb();
    const service = new IbpService(handle.db);

    // Note: the current implementation allows only one open action per bond —
    // after executeAction the bond status becomes 'occupied', which blocks a
    // second execute. We therefore use a single action here. The important
    // property under test is that running the sweeper a second time finds no
    // open expired actions and leaves the bond's slashed_cents unchanged.
    const { identityId } = service.createIdentity({ publicKey: generatePublicKey() });
    const { bondId } = service.lockBond({
      identityId,
      amountCents: 1000,
      currency: "USD",
      ttlSeconds: 1,
      reason: "attack-2.2",
    });

    await service.executeAction({
      identityId,
      bondId,
      actionType: "attack-2.2",
      exposure_cents: 500,
    });

    // Advance time past the 1-second TTL
    vi.setSystemTime(new Date("2026-03-04T12:00:02.000Z"));

    // First sweep: must find and slash the one open expired action
    const firstSweep = service.sweepExpiredActions();
    expect(firstSweep.slashedCount).toBe(1);

    const afterFirst = handle.db
      .prepare(`SELECT status, slashed_cents FROM bonds WHERE id = ?`)
      .get(bondId) as { status: string; slashed_cents: number };
    expect(afterFirst.status).toBe("slashed");
    expect(afterFirst.slashed_cents).toBe(1000); // full bond amount slashed once

    // Second sweep: the action is no longer 'open', so nothing should be slashed
    const secondSweep = service.sweepExpiredActions();
    expect(secondSweep.slashedCount).toBe(0);

    // slashed_cents must be unchanged — the bond was not slashed a second time
    const afterSecond = handle.db
      .prepare(`SELECT status, slashed_cents FROM bonds WHERE id = ?`)
      .get(bondId) as { status: string; slashed_cents: number };
    expect(afterSecond.status).toBe("slashed");
    expect(afterSecond.slashed_cents).toBe(1000); // still 1000, not 2000

    validateInvariants(handle.db);
  });
});

describe("Attack 2.3 — expiry during execution", () => {
  const handles: DatabaseHandle[] = [];

  afterEach(() => {
    vi.useRealTimers();
    while (handles.length > 0) {
      handles.pop()?.close();
    }
  });

  function buildDb(): DatabaseHandle {
    const handle = createDatabase(":memory:");
    handles.push(handle);
    return handle;
  }

  it("rejects executeAction against an expired bond and records no action", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-04T12:00:00.000Z"));

    const handle = buildDb();
    const service = new IbpService(handle.db);

    const { identityId } = service.createIdentity({ publicKey: generatePublicKey() });
    const { bondId } = service.lockBond({
      identityId,
      amountCents: 1000,
      currency: "USD",
      ttlSeconds: 1,
      reason: "attack-2.3",
    });

    // Advance time 2 seconds past the 1-second TTL
    vi.setSystemTime(new Date("2026-03-04T12:00:02.000Z"));

    // Execute against the now-expired bond — must be rejected
    await expect(
      service.executeAction({
        identityId,
        bondId,
        actionType: "attack-2.3",
        exposure_cents: 100,
      })
    ).rejects.toMatchObject({ code: "BOND_EXPIRED" });

    // No action should have been recorded
    const actions = handle.db
      .prepare(`SELECT id FROM actions WHERE bond_id = ?`)
      .all(bondId) as Array<{ id: string }>;
    expect(actions).toHaveLength(0);

    // Bond status must be 'expired' — assertBondCanBackAction marks it on detection
    const bond = handle.db
      .prepare(`SELECT status, outstanding_exposure_cents FROM bonds WHERE id = ?`)
      .get(bondId) as { status: string; outstanding_exposure_cents: number };
    expect(bond.status).toBe("expired");
    expect(bond.outstanding_exposure_cents).toBe(0);

    validateInvariants(handle.db);
  });
});

describe("validateInvariants", () => {
  const handles: DatabaseHandle[] = [];

  afterEach(() => {
    while (handles.length > 0) {
      handles.pop()?.close();
    }
  });

  function buildDb(): DatabaseHandle {
    const handle = createDatabase(":memory:");
    handles.push(handle);
    return handle;
  }

  it("passes all 8 invariants on a clean database after identity creation and bond lock", () => {
    const handle = buildDb();
    const service = new IbpService(handle.db);

    const { identityId } = service.createIdentity({ publicKey: generatePublicKey() });

    service.lockBond({
      identityId,
      amountCents: 5000,
      currency: "USD",
      ttlSeconds: 300,
      reason: "smoke-test",
    });

    expect(() => validateInvariants(handle.db)).not.toThrow();
  });
});
