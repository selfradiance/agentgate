import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Adversarial test: verifies that the outbound HTTP safety rail actually aborts
 * and throws when an external server tries to flood AgentGate with a response
 * body larger than the configured limit.
 *
 * Strategy: set AGENTGATE_MAX_RESPONSE_BYTES=1024 (1 KB), then spin up a local
 * server that returns 2 KB. Because 127.0.0.1 is on the default allowlist, no
 * allowlist change is needed. vi.resetModules() + dynamic import ensures http.ts
 * picks up the env var as a fresh module-level constant.
 */
describe("outbound HTTP response size enforcement", () => {
  let server: ReturnType<typeof createServer>;
  let serverPort: number;
  let postJson: (url: string, body: unknown) => Promise<unknown>;

  beforeAll(async () => {
    // Set a small limit (1 KB) so the test doesn't need to transfer 1 MB
    process.env.AGENTGATE_MAX_RESPONSE_BYTES = "1024";

    // Reset module cache so http.ts re-reads the env var on import
    vi.resetModules();
    ({ postJson } = await import("../src/http.js"));

    // Start a local server that responds with 2 KB — double the test limit
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(Buffer.alloc(2048)); // 2 048 bytes of zeros
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    serverPort = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.AGENTGATE_MAX_RESPONSE_BYTES;
  });

  it("aborts and throws RESPONSE_TOO_LARGE when the response body exceeds the configured limit", async () => {
    await expect(
      postJson(`http://127.0.0.1:${serverPort}`, {})
    ).rejects.toThrow("RESPONSE_TOO_LARGE");
  });
});
