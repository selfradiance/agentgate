import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AppInstance, createApp } from "../src/app";

const apps: AppInstance[] = [];

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

function signHeaders(privateKey: KeyObject, body: Record<string, unknown>, timestamp = Date.now().toString()) {
  const message = createHash("sha256").update(`${timestamp}${JSON.stringify(body)}`).digest();
  return {
    "x-agentgate-timestamp": timestamp,
    "x-agentgate-signature": sign(null, message, privateKey).toString("base64")
  };
}

async function buildApp() {
  const app = createApp({ dbPath: ":memory:" });
  apps.push(app);
  await app.ready();
  return app;
}

async function createIdentity(app: AppInstance) {
  const signer = createSigner();
  const response = await app.inject({
    method: "POST",
    url: "/v1/identities",
    headers: { "x-nonce": randomUUID() },
    payload: { publicKey: signer.publicKey }
  });
  return { signer, identityId: response.json().identityId as string };
}

async function lockBond(app: AppInstance, identityId: string, amountCents: number, reason: string, ttlSeconds: number) {
  return (await app.inject({
    method: "POST",
    url: "/v1/bonds/lock",
    headers: { "x-nonce": randomUUID() },
    payload: { identityId, amountCents, currency: "USD", ttlSeconds, reason }
  })).json().bondId as string;
}

afterEach(async () => {
  vi.useRealTimers();
  while (apps.length > 0) {
    const app = apps.pop();
    if (app) await app.close();
  }
});

describe("sweepExpiredActions", () => {
  it("slashes the bond and marks the action malicious when the bond TTL has elapsed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));

    const app = await buildApp();
    const { identityId, signer } = await createIdentity(app);
    const bondId = await lockBond(app, identityId, 1000, "sweep-test", 1);

    const actionBody = { identityId, bondId, actionType: "sweep-test", payload: { test: true } };
    const executeResponse = await app.inject({
      method: "POST",
      url: "/v1/actions/execute",
      payload: actionBody,
      headers: { ...signHeaders(signer.privateKey, actionBody), "x-nonce": randomUUID() }
    });
    const actionId = executeResponse.json().actionId as string;

    // Bond is occupied before the sweep
    const beforeStats = (await app.inject({ method: "GET", url: "/v1/stats" })).json();
    expect(beforeStats.totalActiveBonds).toBe(1);

    // Advance time 2 seconds past the 1-second TTL
    vi.setSystemTime(new Date("2026-03-01T12:00:02.000Z"));

    const swept = app.sweep();
    expect(swept).toBe(1);

    // Bond is no longer counted as active after the sweep
    const afterStats = (await app.inject({ method: "GET", url: "/v1/stats" })).json();
    expect(afterStats.totalActiveBonds).toBe(0);

    // Attempting to resolve the swept action returns ACTION_ALREADY_RESOLVED
    const resolveBody = { outcome: "success" as const };
    const resolveResponse = await app.inject({
      method: "POST",
      url: `/v1/actions/${actionId}/resolve`,
      payload: resolveBody,
      headers: { ...signHeaders(signer.privateKey, resolveBody), "x-nonce": randomUUID() }
    });
    expect(resolveResponse.statusCode).toBe(409);
    expect(resolveResponse.json().error).toBe("ACTION_ALREADY_RESOLVED");
  });

  it("does not sweep actions whose bond TTL has not yet elapsed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));

    const app = await buildApp();
    const { identityId, signer } = await createIdentity(app);
    const bondId = await lockBond(app, identityId, 1000, "long-bond", 3600);

    const actionBody = { identityId, bondId, actionType: "long-running", payload: {} };
    await app.inject({
      method: "POST",
      url: "/v1/actions/execute",
      payload: actionBody,
      headers: signHeaders(signer.privateKey, actionBody)
    });

    // Advance 30 seconds — well within the 3600-second TTL
    vi.setSystemTime(new Date("2026-03-01T12:00:30.000Z"));

    const swept = app.sweep();
    expect(swept).toBe(0);

    const stats = (await app.inject({ method: "GET", url: "/v1/stats" })).json();
    expect(stats.totalActiveBonds).toBe(1);
  });
});
