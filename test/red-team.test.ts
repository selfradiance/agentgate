import type Database from "better-sqlite3";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
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

  // 6. Every action with status 'malicious' must have its bond status set to 'slashed'
  //    (the settlement sets bond.status = 'slashed' and outstanding_exposure_cents = 0)
  const inv6 = db
    .prepare(
      `SELECT a.id AS action_id, b.id AS bond_id, b.status AS bond_status
       FROM actions a
       JOIN bonds b ON a.bond_id = b.id
       WHERE a.status = 'malicious'
         AND b.status != 'slashed'`
    )
    .all() as Array<{ action_id: string; bond_id: string; bond_status: string }>;
  if (inv6.length > 0) {
    throw new Error(
      `Invariant 6 violated — malicious actions whose bond is not slashed: ${JSON.stringify(inv6)}`
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
