import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentAdapter } from "../src/agent-adapter";
import { createApp } from "../src/app";
import { createMcpServer } from "../src/mcp/server";

describe("MCP end-to-end", () => {
  let app: ReturnType<typeof createApp>;
  let client: Client;
  let identityFilePath: string;

  // Shared across the sequential tool calls
  let identityId: string;
  let bondId: string;
  let actionId: string;

  beforeAll(async () => {
    // Start the AgentGate HTTP server with an isolated in-memory database
    app = createApp({ dbPath: ":memory:" });
    await app.ready();
    await app.listen({ port: 0, host: "127.0.0.1" });

    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP server did not bind to a port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    // Use a temp file so the test never touches the real agent-identity.json
    identityFilePath = path.join(os.tmpdir(), `agentgate-test-${randomUUID()}.json`);
    const adapter = new AgentAdapter(baseUrl, identityFilePath);

    // Wire up the MCP server and a test client via in-process transports
    const mcpServer = createMcpServer(adapter);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.1.0" }, { capabilities: {} });

    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await app.close();
    try {
      fs.unlinkSync(identityFilePath);
    } catch {
      // ignore — file may not exist if create_identity was never reached
    }
  });

  it("create_identity returns an identityId", async () => {
    const result = await client.callTool({ name: "create_identity", arguments: {} });
    expect(result.content).toHaveLength(1);
    const item = result.content[0] as { type: string; text: string };
    expect(item.type).toBe("text");
    const data = JSON.parse(item.text) as { identityId: string };
    expect(typeof data.identityId).toBe("string");
    expect(data.identityId.length).toBeGreaterThan(0);
    identityId = data.identityId;
  });

  it("lock_bond returns a bondId", async () => {
    const result = await client.callTool({
      name: "lock_bond",
      arguments: { amount_cents: 1000, ttl_seconds: 300, reason: "mcp-integration-test" }
    });
    expect(result.content).toHaveLength(1);
    const item = result.content[0] as { type: string; text: string };
    expect(item.type).toBe("text");
    const data = JSON.parse(item.text) as { bondId: string; status: string };
    expect(typeof data.bondId).toBe("string");
    expect(data.bondId).toMatch(/^bond_/);
    expect(data.status).toBe("active");
    bondId = data.bondId;
  });

  it("execute_bonded_action returns an actionId", async () => {
    const result = await client.callTool({
      name: "execute_bonded_action",
      arguments: {
        bondId,
        actionType: "mcp-test-action",
        payload: JSON.stringify({ test: true }),
        exposure_cents: 100
      }
    });
    expect(result.content).toHaveLength(1);
    const item = result.content[0] as { type: string; text: string };
    expect(item.type).toBe("text");
    const data = JSON.parse(item.text) as { actionId: string; status: string };
    expect(typeof data.actionId).toBe("string");
    expect(data.actionId).toMatch(/^action_/);
    expect(data.status).toBe("open");
    actionId = data.actionId;
  });

  it("resolve_action returns success outcome with settlement amounts", async () => {
    const result = await client.callTool({
      name: "resolve_action",
      arguments: { actionId, outcome: "success" }
    });
    expect(result.content).toHaveLength(1);
    const item = result.content[0] as { type: string; text: string };
    expect(item.type).toBe("text");
    const data = JSON.parse(item.text) as {
      actionId: string;
      outcome: string;
      refundCents: number;
      burnedCents: number;
      slashedCents: number;
    };
    expect(data.actionId).toBe(actionId);
    expect(data.outcome).toBe("success");
    expect(data.refundCents).toBe(1000);
    expect(data.burnedCents).toBe(0);
    expect(data.slashedCents).toBe(0);
  });

  it("get_reputation returns identity with updated stats", async () => {
    const result = await client.callTool({
      name: "get_reputation",
      arguments: { identityId }
    });
    expect(result.content).toHaveLength(1);
    const item = result.content[0] as { type: string; text: string };
    expect(item.type).toBe("text");
    const data = JSON.parse(item.text) as {
      identityId: string;
      reputation: { score: number; stats: { locks: number; actions: number; successes: number } };
    };
    expect(data.identityId).toBe(identityId);
    expect(data.reputation.stats.locks).toBe(1);
    expect(data.reputation.stats.actions).toBe(1);
    expect(data.reputation.stats.successes).toBe(1);
    expect(data.reputation.score).toBe(15); // 2*locks + 3*actions + 10*successes
  });
});
