import "dotenv/config";
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
    const backupPath = await backupDatabase(dbPath, "data/backups");
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

  // Warn at startup if auth keys are missing and dev mode is off — requests will be rejected per-route
  if (process.env.AGENTGATE_DEV_MODE !== "true") {
    const missing = ["AGENTGATE_REST_KEY", "AGENTGATE_ADMIN_KEY", "AGENTGATE_MCP_KEY"].filter(
      (key) => !process.env[key]
    );
    if (missing.length > 0) {
      logger.warn(
        `Auth keys not set: ${missing.join(", ")}. Requests to affected endpoints will be rejected. Set AGENTGATE_DEV_MODE=true to skip auth for local development.`
      );
    }
  }

  const mcpHttpServer = startMcpHttpServer(3001);

  const sweepInterval = setInterval(() => {
    const result = app.sweepExpiredActions();
    logger.info(`sweeper: slashed ${result.slashedCount} expired actions`);
    const nonces = app.cleanExpiredNonces();
    logger.info(`nonce-cleanup: purged ${nonces.purgedCount} expired nonces`);
    const buckets = app.cleanExpiredBuckets();
    logger.info(`bucket-cleanup: purged ${buckets.purgedCount} expired rate-limit buckets`);
  }, SWEEP_INTERVAL_MS);

  app.addHook("onClose", async () => {
    clearInterval(sweepInterval);
  });

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
