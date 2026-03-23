import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject
} from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp, type AppInstance } from "../src/app";

function fromBase64Url(value: string) {
  const paddedValue = `${value}${"===".slice((value.length + 3) % 4)}`;
  return Buffer.from(paddedValue.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("base64");
}

function createSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  if (!jwk.x) throw new Error("Missing Ed25519 public key");
  return { privateKey, publicKey: fromBase64Url(jwk.x) };
}

function signHeaders(privateKey: KeyObject, body: Record<string, unknown>, url: string, timestamp = Date.now().toString(), nonce = randomUUID()) {
  const method = "POST";
  const message = createHash("sha256").update(`${nonce}${method}${url}${timestamp}${JSON.stringify(body)}`).digest();
  return {
    "x-agentgate-timestamp": timestamp,
    "x-agentgate-signature": sign(null, message, privateKey).toString("base64"),
    "x-nonce": nonce
  };
}

/**
 * Adversarial test: verifies that the outbound HTTP safety rail actually aborts
 * and throws when an external server tries to flood AgentGate with a response
 * body larger than the configured limit.
 *
 * Strategy: set AGENTGATE_MAX_RESPONSE_BYTES=1024 (1 KB), then spin up a local
 * server that returns 2 KB. The test explicitly allowlists that ephemeral
 * loopback port. vi.resetModules() + dynamic import ensures http.ts re-reads
 * the env vars.
 */
describe("outbound HTTP response size enforcement", () => {
  let server: ReturnType<typeof createServer>;
  let serverPort: number;
  let postJson: (url: string, body: unknown) => Promise<unknown>;

  beforeAll(async () => {
    // Set a small limit (1 KB) so the test doesn't need to transfer 1 MB
    process.env.AGENTGATE_MAX_RESPONSE_BYTES = "1024";

    // Start a local server that responds with 2 KB — double the test limit
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(Buffer.alloc(2048)); // 2 048 bytes of zeros
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    serverPort = (server.address() as AddressInfo).port;
    process.env.AGENTGATE_HTTP_ALLOWLIST = `127.0.0.1:${serverPort}`;

    // Reset module cache so http.ts re-reads the env vars on import
    vi.resetModules();
    ({ postJson } = await import("../src/http.js"));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.AGENTGATE_MAX_RESPONSE_BYTES;
    delete process.env.AGENTGATE_HTTP_ALLOWLIST;
  });

  it("aborts and throws RESPONSE_TOO_LARGE when the response body exceeds the configured limit", async () => {
    await expect(
      postJson(`http://127.0.0.1:${serverPort}`, {})
    ).rejects.toThrow("RESPONSE_TOO_LARGE");
  });
});

describe("outbound HTTP 204 empty response handling", () => {
  let server: ReturnType<typeof createServer>;
  let serverPort: number;
  const apps: AppInstance[] = [];

  beforeAll(async () => {
    // Local server that returns 204 No Content
    server = createServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    serverPort = (server.address() as AddressInfo).port;
    process.env.AGENTGATE_HTTP_ALLOWLIST = `127.0.0.1:${serverPort}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.AGENTGATE_HTTP_ALLOWLIST;
  });

  afterEach(async () => {
    while (apps.length > 0) {
      await apps.pop()?.close();
    }
  });

  it("outbound action with 204 empty response does not crash and action is not stuck open", async () => {
    const app = createApp({ dbPath: ":memory:" });
    apps.push(app);
    await app.ready();

    // Create identity
    const signer = createSigner();
    const identityPayload = { publicKey: signer.publicKey };
    const idRes = await app.inject({
      method: "POST",
      url: "/v1/identities",
      headers: signHeaders(signer.privateKey, identityPayload, "/v1/identities"),
      payload: identityPayload
    });
    const { identityId } = idRes.json() as { identityId: string };

    // Lock bond
    const bondPayload = { identityId, amountCents: 1000, currency: "USD", ttlSeconds: 300, reason: "204-test" };
    const bondRes = await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      headers: signHeaders(signer.privateKey, bondPayload, "/v1/bonds/lock"),
      payload: bondPayload
    });
    const { bondId } = bondRes.json() as { bondId: string };

    // Execute a market.http action against the 204 server
    const actionBody = {
      identityId,
      bondId,
      actionType: "market.http",
      payload: { url: `http://127.0.0.1:${serverPort}/test`, body: {} },
      exposure_cents: 500
    };
    const actionRes = await app.inject({
      method: "POST",
      url: "/v1/actions/execute",
      headers: signHeaders(signer.privateKey, actionBody, "/v1/actions/execute"),
      payload: actionBody
    });

    // Should succeed — not crash with a 500
    expect(actionRes.statusCode).toBe(201);
    const { actionId } = actionRes.json() as { actionId: string };

    // Action should be open (not stuck, not failed)
    const action = app.db
      .prepare("SELECT status FROM actions WHERE id = ?")
      .get(actionId) as { status: string };
    expect(action.status).toBe("open");
  });
});
