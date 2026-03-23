import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { backupDatabase } from "../src/backup";
import { createDatabase } from "../src/db";

describe("backupDatabase", () => {
  const pathsToDelete: string[] = [];

  afterEach(() => {
    while (pathsToDelete.length > 0) {
      const target = pathsToDelete.pop();
      if (!target) continue;

      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch {
        // ignore temp cleanup failures
      }
    }
  });

  it("creates a consistent backup from a WAL-mode database", async () => {
    const tempRoot = path.join(os.tmpdir(), `agentgate-backup-${randomUUID()}`);
    const dbPath = path.join(tempRoot, "data", "agentgate.sqlite");
    const backupDir = path.join(tempRoot, "backups");
    pathsToDelete.push(tempRoot);

    const handle = createDatabase(dbPath);
    handle.db
      .prepare(
        `INSERT INTO identities (id, public_key, agent_name, created_at, status)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run("id_backup", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "backup-test", new Date().toISOString(), "active");

    const backupPath = await backupDatabase(dbPath, backupDir);
    handle.close();

    const backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      const row = backupDb
        .prepare(`SELECT id, public_key FROM identities WHERE id = ?`)
        .get("id_backup") as { id: string; public_key: string } | undefined;

      expect(row).toEqual({
        id: "id_backup",
        public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
      });
    } finally {
      backupDb.close();
    }
  });
});
