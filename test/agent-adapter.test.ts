import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentAdapter } from "../src/agent-adapter";
import { createApp } from "../src/app";

describe("AgentAdapter", () => {
  let app: ReturnType<typeof createApp>;
  let identityFilePath: string;
  let originalDevMode: string | undefined;

  beforeAll(async () => {
    originalDevMode = process.env.AGENTGATE_DEV_MODE;
    process.env.AGENTGATE_DEV_MODE = "true";

    app = createApp({ dbPath: ":memory:" });
    await app.ready();
    await app.listen({ port: 0, host: "127.0.0.1" });

    identityFilePath = path.join(os.tmpdir(), `agentgate-adapter-${randomUUID()}.json`);
  });

  afterAll(async () => {
    await app.close();

    if (originalDevMode === undefined) {
      delete process.env.AGENTGATE_DEV_MODE;
    } else {
      process.env.AGENTGATE_DEV_MODE = originalDevMode;
    }

    try {
      fs.unlinkSync(identityFilePath);
    } catch {
      // ignore cleanup failures in temp files
    }
  });

  it("auto-creates an identity before the first signed write", async () => {
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP server did not bind to a port");
    }

    const adapter = new AgentAdapter(`http://127.0.0.1:${address.port}`, identityFilePath);
    const result = await adapter.lockBond(1000, 300, "auto-init");

    expect(result.bondId).toMatch(/^bond_/);

    const savedIdentity = JSON.parse(fs.readFileSync(identityFilePath, "utf8")) as { identityId?: string };
    expect(savedIdentity.identityId).toMatch(/^id_/);
  });
});
