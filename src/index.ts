import { createApp } from "./app";
import { backupDatabase } from "./backup";
import { registerDashboard } from "./dashboard";
import { createLogger } from "./logger";
import { startMcpHttpServer } from "./mcp/http-server";

const SWEEP_INTERVAL_MS = 60_000;

async function main() {
  const logger = createLogger();

  const dbPath = process.env.AGENTGATE_DB_PATH || "data/agentgate.sqlite";

  try {
    const backupPath = backupDatabase(dbPath, "data/backups");
    logger.info(`database backup created: ${backupPath}`);
  } catch (error) {
    logger.warn(`database backup skipped: ${String(error)}`);
  }

  const app = createApp({ dbPath });

  registerDashboard(app);

  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 3000);

  try {
    await app.listen({ host, port });
    logger.info(`server listening on http://${host}:${port}`);
  } catch (error) {
    logger.error(`server failed to start: ${String(error)}`);
    process.exit(1);
  }

  const mcpHttpServer = startMcpHttpServer(3001);

  const sweepInterval = setInterval(() => {
    const result = app.sweepExpiredActions();
    logger.info(`sweeper: slashed ${result.slashedCount} expired actions`);
    const nonces = app.cleanExpiredNonces();
    logger.info(`nonce-cleanup: purged ${nonces.purgedCount} expired nonces`);
  }, SWEEP_INTERVAL_MS);

  const shutdown = async () => {
    clearInterval(sweepInterval);
    await app.close();
    await new Promise<void>((resolve) => mcpHttpServer.close(() => resolve()));
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main();
