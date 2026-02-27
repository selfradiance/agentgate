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
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS identities (
      id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bonds (
      id TEXT PRIMARY KEY,
      identity_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      ttl_seconds INTEGER NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      closed_at TEXT,
      refund_cents INTEGER NOT NULL DEFAULT 0,
      burned_cents INTEGER NOT NULL DEFAULT 0,
      slashed_cents INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(identity_id) REFERENCES identities(id)
    );

    CREATE TABLE IF NOT EXISTS actions (
      id TEXT PRIMARY KEY,
      identity_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      payload TEXT,
      bond_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      FOREIGN KEY(identity_id) REFERENCES identities(id),
      FOREIGN KEY(bond_id) REFERENCES bonds(id)
    );
  `);

  return {
    db,
    close: () => db.close()
  };
}
