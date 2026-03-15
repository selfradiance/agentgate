import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export interface DatabaseHandle {
  db: Database.Database;
  close: () => void;
}

export function createDatabase(filename: string): DatabaseHandle {
  if (filename !== ":memory:") {
    const directory = path.dirname(filename);
    fs.mkdirSync(directory, { recursive: true });
  }

  const db = new Database(filename);

  // WAL mode allows concurrent reads while writing, improving performance
  db.pragma("journal_mode = WAL");
  // Wait up to 5 seconds when the database is locked instead of failing immediately
  db.pragma("busy_timeout = 5000");

  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS identities (
      id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL UNIQUE,
      agent_name TEXT,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'banned'))
    );

    CREATE TABLE IF NOT EXISTS bonds (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
  currency TEXT NOT NULL,
  ttl_seconds INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'occupied', 'released', 'burned', 'slashed', 'expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  refund_cents INTEGER NOT NULL DEFAULT 0,
  burned_cents INTEGER NOT NULL DEFAULT 0,
  slashed_cents INTEGER NOT NULL DEFAULT 0 CHECK(slashed_cents >= 0),
  outstanding_exposure_cents INTEGER NOT NULL DEFAULT 0 CHECK(outstanding_exposure_cents >= 0),
  FOREIGN KEY(identity_id) REFERENCES identities(id)
);

    CREATE TABLE IF NOT EXISTS actions (
      id TEXT PRIMARY KEY,
      identity_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      payload TEXT,
      bond_id TEXT NOT NULL,
      exposure_cents INTEGER NOT NULL CHECK(exposure_cents >= 0),
      status TEXT NOT NULL CHECK(status IN ('open', 'success', 'failed', 'malicious')),
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      FOREIGN KEY(identity_id) REFERENCES identities(id),
      FOREIGN KEY(bond_id) REFERENCES bonds(id)
    );

    CREATE TABLE IF NOT EXISTS action_execute_buckets (
      identity_id TEXT NOT NULL,
      bucket_start INTEGER NOT NULL,
      requested_at INTEGER NOT NULL,
      FOREIGN KEY(identity_id) REFERENCES identities(id)
    );

    CREATE INDEX IF NOT EXISTS action_execute_buckets_identity_requested_at_idx
      ON action_execute_buckets(identity_id, requested_at);

    CREATE TABLE IF NOT EXISTS nonces (
      nonce TEXT NOT NULL,
      identity_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (nonce, identity_id),
      FOREIGN KEY(identity_id) REFERENCES identities(id)
    );

    CREATE TABLE IF NOT EXISTS markets (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      resolution_deadline TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      outcome TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
  `);

  // Migration: add agent_name column to existing databases that predate it
  try {
    db.exec(`ALTER TABLE identities ADD COLUMN agent_name TEXT`);
  } catch {
    // Column already exists — no-op
  }

  // Migration: add unique index on public_key for existing databases created before the UNIQUE constraint
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS identities_public_key_unique ON identities(public_key)`);

  // Migration: add status column to existing databases that predate it
  try {
    db.exec(`ALTER TABLE identities ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  } catch {
    // Column already exists — no-op
  }

  // Migration: validate existing data meets CHECK constraint invariants.
  // SQLite CHECK constraints only apply to new tables — existing tables created before the
  // constraints were added won't have them enforced. This validates data integrity at startup.
  const violations: string[] = [];

  const badBondAmounts = db.prepare(`SELECT COUNT(*) as n FROM bonds WHERE amount_cents < 0`).get() as { n: number };
  if (badBondAmounts.n > 0) violations.push(`${badBondAmounts.n} bonds with negative amount_cents`);

  const badExposure = db.prepare(`SELECT COUNT(*) as n FROM bonds WHERE outstanding_exposure_cents < 0`).get() as { n: number };
  if (badExposure.n > 0) violations.push(`${badExposure.n} bonds with negative outstanding_exposure_cents`);

  const badSlashed = db.prepare(`SELECT COUNT(*) as n FROM bonds WHERE slashed_cents < 0`).get() as { n: number };
  if (badSlashed.n > 0) violations.push(`${badSlashed.n} bonds with negative slashed_cents`);

  const badBondStatus = db.prepare(`SELECT COUNT(*) as n FROM bonds WHERE status NOT IN ('active', 'occupied', 'released', 'burned', 'slashed', 'expired')`).get() as { n: number };
  if (badBondStatus.n > 0) violations.push(`${badBondStatus.n} bonds with invalid status`);

  const badActionExposure = db.prepare(`SELECT COUNT(*) as n FROM actions WHERE exposure_cents < 0`).get() as { n: number };
  if (badActionExposure.n > 0) violations.push(`${badActionExposure.n} actions with negative exposure_cents`);

  const badActionStatus = db.prepare(`SELECT COUNT(*) as n FROM actions WHERE status NOT IN ('open', 'success', 'failed', 'malicious')`).get() as { n: number };
  if (badActionStatus.n > 0) violations.push(`${badActionStatus.n} actions with invalid status`);

  const badIdentityStatus = db.prepare(`SELECT COUNT(*) as n FROM identities WHERE status NOT IN ('active', 'banned')`).get() as { n: number };
  if (badIdentityStatus.n > 0) violations.push(`${badIdentityStatus.n} identities with invalid status`);

  if (violations.length > 0) {
    throw new Error(`Database integrity check failed: ${violations.join("; ")}`);
  }

  return {
    db,
    close: () => db.close()
  };
}
