import { createApp } from "./app";

const SWEEP_INTERVAL_MS = 60_000;

async function main() {
  const app = createApp({
    dbPath: process.env.IBP_DB_PATH || "data/ibp.sqlite"
  });

  try {
    await app.listen({
      host: process.env.HOST || "127.0.0.1",
      port: Number(process.env.PORT || 3000)
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }

  const sweepInterval = setInterval(() => {
    const result = app.sweepExpiredActions();
    console.log(`[sweeper] slashed ${result.slashedCount} expired actions`);
  }, SWEEP_INTERVAL_MS);

  const shutdown = async () => {
    clearInterval(sweepInterval);
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main();
