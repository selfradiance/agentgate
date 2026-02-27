import { createApp } from "./app";

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
}

void main();
