import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";

const MAX_BACKUPS = 5;

export async function backupDatabase(sourcePath: string, backupDir: string): Promise<string> {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source database not found: ${sourcePath}`);
  }

  fs.mkdirSync(backupDir, { recursive: true });

  const baseName = path.basename(sourcePath, ".sqlite");
  const timestamp = new Date().toISOString().replace(/:/g, "-").slice(0, 19);
  const backupName = `${baseName}-${timestamp}.sqlite`;
  const backupPath = path.join(backupDir, backupName);

  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });

  try {
    await db.backup(backupPath);
  } finally {
    db.close();
  }

  pruneOldBackups(backupDir, baseName);

  return backupPath;
}

function pruneOldBackups(backupDir: string, baseName: string): void {
  const entries = fs.readdirSync(backupDir)
    .filter((f) => f.startsWith(`${baseName}-`) && f.endsWith(".sqlite"))
    .sort();

  const toDelete = entries.slice(0, Math.max(0, entries.length - MAX_BACKUPS));
  for (const file of toDelete) {
    fs.rmSync(path.join(backupDir, file));
  }
}
