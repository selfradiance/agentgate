import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject
} from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";

const apps: ReturnType<typeof createApp>[] = [];

function fromBase64Url(value: string) {
  const paddedValue = `${value}${"===".slice((value.length + 3) % 4)}`;
  return Buffer.from(paddedValue.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("base64");
}

function createSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;

  if (!jwk.x) {
    throw new Error("Missing Ed25519 public key");
  }

  return {
    privateKey,
    publicKey: fromBase64Url(jwk.x)
  };
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

async function createIdentity(app: ReturnType<typeof createApp>) {
  const signer = createSigner();
  const payload = { publicKey: signer.publicKey };
  const response = await app.inject({
    method: "POST",
    url: "/v1/identities",
    headers: { ...signHeaders(signer.privateKey, payload, "/v1/identities") },
    payload
  });

  return {
    signer,
    identityId: response.json().identityId as string
  };
}

async function resolveAction(
  app: ReturnType<typeof createApp>,
  resolverSigner: { privateKey: KeyObject },
  resolverId: string,
  actionId: string,
  outcome: "success" | "failed" | "malicious"
) {
  const resolveBody = { outcome, resolverId };
  const resolveUrl = `/v1/actions/${actionId}/resolve`;
  return app.inject({
    method: "POST",
    url: resolveUrl,
    payload: resolveBody,
    headers: signHeaders(resolverSigner.privateKey, resolveBody, resolveUrl)
  });
}

async function lockBond(
  app: ReturnType<typeof createApp>,
  signer: { privateKey: KeyObject },
  identityId: string,
  amountCents: number,
  reason: string,
  nonce = randomUUID()
) {
  const payload = {
    identityId,
    amountCents,
    currency: "USD",
    ttlSeconds: 300,
    reason
  };
  return (await app.inject({
    method: "POST",
    url: "/v1/bonds/lock",
    headers: signHeaders(signer.privateKey, payload, "/v1/bonds/lock", undefined, nonce),
    payload
  })).json().bondId as string;
}

async function executeSignedAction(
  app: ReturnType<typeof createApp>,
  signer: { privateKey: KeyObject },
  body: Record<string, unknown>,
  nonce = randomUUID()
) {
  return app.inject({
    method: "POST",
    url: "/v1/actions/execute",
    payload: body,
    headers: signHeaders(signer.privateKey, body, "/v1/actions/execute", undefined, nonce)
  });
}

async function buildApp() {
  const app = createApp({ dbPath: ":memory:" });
  apps.push(app);
  await app.ready();
  return app;
}

afterEach(async () => {
  vi.useRealTimers();

  while (apps.length > 0) {
    const app = apps.pop();
    if (app) {
      await app.close();
    }
  }
});

describe("IBP state transitions", () => {
  it("returns aggregate stats", async () => {
    const app = await buildApp();

    const { identityId: firstIdentityId, signer: firstSigner } = await createIdentity(app);
    const { identityId: secondIdentityId, signer } = await createIdentity(app);

    const activeBondId = await lockBond(app, firstSigner, firstIdentityId, 1000, "active stats bond");
    const usedBondId = await lockBond(app, signer, secondIdentityId, 2000, "used stats bond");

    const actionBody = {
      identityId: secondIdentityId,
      actionType: "stats-action",
      payload: { note: "stats action" },
      bondId: usedBondId,
      exposure_cents: 100
    };

    await executeSignedAction(app, signer, actionBody);

    const response = await app.inject({
      method: "GET",
      url: "/v1/stats"
    });

    expect(activeBondId).toContain("bond_");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      totalIdentities: 2,
      totalActions: 1,
      totalActiveBonds: 2,
      totalLockedCents: 3000
    });
  });

  it("removes an action-backed bond from active stats only after resolution", async () => {
    const app = await buildApp();

    const { identityId, signer } = await createIdentity(app);
    const { identityId: resolverId, signer: resolverSigner } = await createIdentity(app);

    const bondId = await lockBond(app, signer, identityId, 1500, "resolution stats bond");

    const actionBody = {
      identityId,
      actionType: "open-stats-action",
      payload: "open stats action",
      bondId,
      exposure_cents: 100
    };

    const actionId = (await executeSignedAction(app, signer, actionBody)).json().actionId as string;

    const openStatsResponse = await app.inject({
      method: "GET",
      url: "/v1/stats"
    });

    expect(openStatsResponse.json()).toEqual({
      totalIdentities: 2,
      totalActions: 1,
      totalActiveBonds: 1,
      totalLockedCents: 1500
    });

    await resolveAction(app, resolverSigner, resolverId, actionId, "failed");

    const resolvedStatsResponse = await app.inject({
      method: "GET",
      url: "/v1/stats"
    });

    expect(resolvedStatsResponse.json()).toEqual({
      totalIdentities: 2,
      totalActions: 1,
      totalActiveBonds: 0,
      totalLockedCents: 0
    });
  });

  it("refunds 100% for successful actions and updates identity stats", async () => {
    const app = await buildApp();

    const { identityId, signer } = await createIdentity(app);
    const { identityId: resolverId, signer: resolverSigner } = await createIdentity(app);

    const bondId = await lockBond(app, signer, identityId, 1000, "serious intent");

    const actionBody = {
      identityId,
      actionType: "purchase-intent",
      payload: {
        note: "Ready to proceed"
      },
      bondId,
      exposure_cents: 500
    };

    const actionResponse = await executeSignedAction(app, signer, actionBody);
    const actionId = actionResponse.json().actionId as string;

    const resolveResponse = await resolveAction(app, resolverSigner, resolverId, actionId, "success");

    expect(resolveResponse.statusCode).toBe(200);
    // Settlement is based on action exposure (ceil(500 × 1.2) = 600), not bond amount
    expect(resolveResponse.json()).toMatchObject({
      actionId,
      outcome: "success",
      refundCents: 600,
      burnedCents: 0,
      slashedCents: 0
    });

    const summaryResponse = await app.inject({
      method: "GET",
      url: `/v1/identities/${identityId}`
    });

    expect(summaryResponse.statusCode).toBe(200);
    expect(summaryResponse.json()).toEqual({
      identityId,
      publicKey: signer.publicKey,
      reputation: {
        score: 15,
        stats: {
          locks: 1,
          actions: 1,
          successes: 1,
          failures: 0,
          malicious: 0
        }
      }
    });
  });

  it("burns 5% on failed actions", async () => {
    const app = await buildApp();

    const { identityId, signer } = await createIdentity(app);
    const { identityId: resolverId, signer: resolverSigner } = await createIdentity(app);

    const bondId = await lockBond(app, signer, identityId, 999, "holding bond");

    const actionBody = {
      identityId,
      actionType: "timeout-action",
      payload: "Action with failure risk",
      bondId,
      exposure_cents: 500
    };

    const actionId = (await executeSignedAction(app, signer, actionBody)).json().actionId as string;

    // Settlement is based on action exposure (ceil(500 × 1.2) = 600), not bond amount
    const response = await resolveAction(app, resolverSigner, resolverId, actionId, "failed");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      outcome: "failed",
      refundCents: 570,
      burnedCents: 30,
      slashedCents: 0
    });
  });

  it("slashes 100% for malicious actions", async () => {
    const app = await buildApp();

    const { identityId, signer } = await createIdentity(app);
    const { identityId: resolverId, signer: resolverSigner } = await createIdentity(app);

    const bondId = await lockBond(app, signer, identityId, 5000, "spam deterrence");

    const actionBody = {
      identityId,
      actionType: "bad-faith-action",
      payload: {
        reason: "Bad faith action"
      },
      bondId,
      exposure_cents: 2000
    };

    const actionId = (await executeSignedAction(app, signer, actionBody)).json().actionId as string;

    // Settlement is based on action exposure (ceil(2000 × 1.2) = 2400), not bond amount
    const response = await resolveAction(app, resolverSigner, resolverId, actionId, "malicious");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      outcome: "malicious",
      refundCents: 0,
      burnedCents: 0,
      slashedCents: 2400
    });
  });

  it("rejects self-resolution — executor cannot resolve their own action", async () => {
    const app = await buildApp();

    const { identityId, signer } = await createIdentity(app);
    const { identityId: resolverId, signer: resolverSigner } = await createIdentity(app);

    const bondId = await lockBond(app, signer, identityId, 1000, "self-resolve test");

    const actionBody = {
      identityId,
      actionType: "self-resolve-action",
      payload: { note: "should not self-resolve" },
      bondId,
      exposure_cents: 500
    };

    const actionId = (await executeSignedAction(app, signer, actionBody)).json().actionId as string;

    // Attempt to resolve with the same identity that executed the action
    const selfResolveBody = { outcome: "success" as const, resolverId: identityId };
    const resolveUrl = `/v1/actions/${actionId}/resolve`;
    const selfResolveResponse = await app.inject({
      method: "POST",
      url: resolveUrl,
      payload: selfResolveBody,
      headers: { ...signHeaders(signer.privateKey, selfResolveBody, resolveUrl) }
    });

    expect(selfResolveResponse.statusCode).toBe(403);
    expect(selfResolveResponse.json().error).toBe("SELF_RESOLUTION_FORBIDDEN");

    // Confirm a different identity CAN resolve the same action
    const resolveResponse = await resolveAction(app, resolverSigner, resolverId, actionId, "success");
    expect(resolveResponse.statusCode).toBe(200);
    expect(resolveResponse.json()).toMatchObject({
      actionId,
      outcome: "success",
      refundCents: 600,
      burnedCents: 0,
      slashedCents: 0
    });
  });

  it("rejects actions that reference inactive bonds", async () => {
    const app = await buildApp();

    const { identityId, signer } = await createIdentity(app);
    const { identityId: resolverId, signer: resolverSigner } = await createIdentity(app);

    const bondId = await lockBond(app, signer, identityId, 1200, "released bond");

    const firstActionBody = {
      identityId,
      actionType: "first-action",
      payload: "First action",
      bondId,
      exposure_cents: 100
    };

    const firstActionId = (await executeSignedAction(app, signer, firstActionBody)).json().actionId as string;

    // Resolve the action as success — bond becomes released
    await resolveAction(app, resolverSigner, resolverId, firstActionId, "success");

    const secondActionBody = {
      identityId,
      actionType: "second-action",
      payload: "Second action",
      bondId,
      exposure_cents: 100
    };

    const secondActionResponse = await executeSignedAction(app, signer, secondActionBody);

    expect(secondActionResponse.statusCode).toBe(409);
    expect(secondActionResponse.json()).toEqual({
      error: "BOND_NOT_ACTIVE",
      message: "Bond is not active"
    });
  });

  it("accepts signed action execution using the caller's body field order", async () => {
    const app = await buildApp();

    const { identityId, signer } = await createIdentity(app);

    const bondId = await lockBond(app, signer, identityId, 1000, "field order");

    const actionBody = {
      bondId,
      payload: { note: "different order" },
      actionType: "ordered-action",
      identityId,
      exposure_cents: 100
    };

    const response = await executeSignedAction(app, signer, actionBody);

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      status: "open"
    });
  });

  it("rejects action execution with an invalid signature", async () => {
    const app = await buildApp();

    const { identityId, signer } = await createIdentity(app);
    const wrongSigner = createSigner();

    const bondId = await lockBond(app, signer, identityId, 1000, "signed request");

    const actionBody = {
      identityId,
      actionType: "signed-action",
      payload: { note: "wrong signer" },
      bondId,
      exposure_cents: 100
    };

    const response = await app.inject({
      method: "POST",
      url: "/v1/actions/execute",
      payload: actionBody,
      headers: { ...signHeaders(wrongSigner.privateKey, actionBody, "/v1/actions/execute") }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "INVALID_SIGNATURE",
      message: "Signature is invalid"
    });
  });

  it("rejects unsigned bond lock requests", async () => {
    const app = await buildApp();

    const { identityId } = await createIdentity(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      headers: { "x-nonce": randomUUID() },
      payload: { identityId, amountCents: 1000, currency: "USD", ttlSeconds: 300, reason: "unsigned" }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "INVALID_SIGNATURE",
      message: "Signature headers are required"
    });
  });

  it("rejects badly-signed bond lock requests", async () => {
    const app = await buildApp();

    const { identityId } = await createIdentity(app);
    const wrongSigner = createSigner();

    const lockPayload = { identityId, amountCents: 1000, currency: "USD", ttlSeconds: 300, reason: "wrong key" };
    const response = await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      headers: { ...signHeaders(wrongSigner.privateKey, lockPayload, "/v1/bonds/lock") },
      payload: lockPayload
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "INVALID_SIGNATURE",
      message: "Signature is invalid"
    });
  });

  it("rejects stale action signatures", async () => {
    const app = await buildApp();

    const { identityId, signer } = await createIdentity(app);

    const bondId = await lockBond(app, signer, identityId, 1000, "stale signature");

    const actionBody = {
      identityId,
      actionType: "stale-action",
      payload: { note: "stale" },
      bondId,
      exposure_cents: 100
    };

    const response = await app.inject({
      method: "POST",
      url: "/v1/actions/execute",
      payload: actionBody,
      headers: { ...signHeaders(signer.privateKey, actionBody, "/v1/actions/execute", `${Date.now() - 61_000}`) }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "INVALID_SIGNATURE",
      message: "Signature timestamp is invalid"
    });
  });

  it("rejects future-dated action signatures", async () => {
    const app = await buildApp();

    const { identityId, signer } = await createIdentity(app);

    const bondId = await lockBond(app, signer, identityId, 1000, "future signature");

    const actionBody = {
      identityId,
      actionType: "future-action",
      payload: { note: "future" },
      bondId,
      exposure_cents: 100
    };

    const response = await app.inject({
      method: "POST",
      url: "/v1/actions/execute",
      payload: actionBody,
      headers: { ...signHeaders(signer.privateKey, actionBody, "/v1/actions/execute", `${Date.now() + 10_000}`) }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "INVALID_SIGNATURE",
      message: "Signature timestamp is invalid"
    });
  });

  it("rate limits the 11th execute request within 60 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-27T12:00:00.000Z"));

    const app = await buildApp();
    const { identityId, signer } = await createIdentity(app);

    for (let index = 0; index < 10; index += 1) {
      const bondId = await lockBond(app, signer, identityId, 1000, `rate-limit-${index}`);
      const response = await executeSignedAction(app, signer, {
        identityId,
        bondId,
        actionType: "rate-limit-action",
        payload: { attempt: index + 1 },
        exposure_cents: 100
      });

      expect(response.statusCode).toBe(201);
    }

    const bondId = await lockBond(app, signer, identityId, 1000, "rate-limit-11");
    const response = await executeSignedAction(app, signer, {
      identityId,
      bondId,
      actionType: "rate-limit-action",
      payload: { attempt: 11 },
      exposure_cents: 100
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({
      error: "RATE_LIMIT_EXCEEDED",
      message: "Identity is limited to 10 action executes per 60 seconds"
    });
  });

  it("enforces progressive minimum bond thresholds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-27T12:00:00.000Z"));

    const app = await buildApp();
    const { identityId, signer } = await createIdentity(app);

    for (let index = 0; index < 10; index += 1) {
      const bondId = await lockBond(app, signer, identityId, 1000, `progressive-a-${index}`);
      const response = await executeSignedAction(app, signer, {
        identityId,
        bondId,
        actionType: "progressive-action",
        payload: { attempt: index + 1 },
        exposure_cents: 100
      });

      expect(response.statusCode).toBe(201);
    }

    vi.setSystemTime(new Date("2026-02-27T12:01:01.000Z"));

    const eleventhBondId = await lockBond(app, signer, identityId, 1000, "progressive-a-11");
    const eleventhResponse = await executeSignedAction(app, signer, {
      identityId,
      bondId: eleventhBondId,
      actionType: "progressive-action",
      payload: { attempt: 11 },
      exposure_cents: 100
    });

    expect(eleventhResponse.statusCode).toBe(201);

    const tooSmallBondId = await lockBond(app, signer, identityId, 1000, "progressive-too-small-2000");
    const tooSmallResponse = await executeSignedAction(app, signer, {
      identityId,
      bondId: tooSmallBondId,
      actionType: "progressive-action",
      payload: { attempt: 12 },
      exposure_cents: 100
    });

    expect(tooSmallResponse.statusCode).toBe(409);
    expect(tooSmallResponse.json()).toEqual({
      error: "MIN_BOND_REQUIRED",
      message: "Minimum bond is 2000 cents for this identity's recent action volume"
    });

    const validMidBondId = await lockBond(app, signer, identityId, 2000, "progressive-valid-2000");
    const validMidResponse = await executeSignedAction(app, signer, {
      identityId,
      bondId: validMidBondId,
      actionType: "progressive-action",
      payload: { attempt: 13 },
      exposure_cents: 100
    });

    expect(validMidResponse.statusCode).toBe(201);

    vi.setSystemTime(new Date("2026-02-27T12:02:02.000Z"));

    for (let index = 0; index < 8; index += 1) {
      const bondId = await lockBond(app, signer, identityId, 2000, `progressive-b-${index}`);
      const response = await executeSignedAction(app, signer, {
        identityId,
        bondId,
        actionType: "progressive-action",
        payload: { attempt: 14 + index },
        exposure_cents: 100
      });

      expect(response.statusCode).toBe(201);
    }

    vi.setSystemTime(new Date("2026-02-27T12:03:03.000Z"));

    const thresholdBondId = await lockBond(app, signer, identityId, 2000, "progressive-threshold-2000");
    const thresholdResponse = await executeSignedAction(app, signer, {
      identityId,
      bondId: thresholdBondId,
      actionType: "progressive-action",
      payload: { attempt: 22 },
      exposure_cents: 100
    });

    expect(thresholdResponse.statusCode).toBe(201);

    const tooSmallHighBondId = await lockBond(app, signer, identityId, 4000, "progressive-too-small-5000");
    const tooSmallHighResponse = await executeSignedAction(app, signer, {
      identityId,
      bondId: tooSmallHighBondId,
      actionType: "progressive-action",
      payload: { attempt: 23 },
      exposure_cents: 100
    });

    expect(tooSmallHighResponse.statusCode).toBe(409);
    expect(tooSmallHighResponse.json()).toEqual({
      error: "MIN_BOND_REQUIRED",
      message: "Minimum bond is 5000 cents for this identity's recent action volume"
    });
  });

  it("multi-action bond accounting: resolving one action preserves other action's exposure", async () => {
    const app = await buildApp();
    const { identityId, signer } = await createIdentity(app);
    const { identityId: resolverId, signer: resolverSigner } = await createIdentity(app);

    const bondId = await lockBond(app, signer, identityId, 2000, "multi-action bond");

    // Execute two actions against the same bond, each with exposure_cents: 500
    const action1Body = { identityId, bondId, actionType: "multi-1", payload: { n: 1 }, exposure_cents: 500 };
    const action1Id = (await executeSignedAction(app, signer, action1Body)).json().actionId as string;

    const action2Body = { identityId, bondId, actionType: "multi-2", payload: { n: 2 }, exposure_cents: 500 };
    const action2Id = (await executeSignedAction(app, signer, action2Body)).json().actionId as string;

    // Both actions open — outstanding should be 1200 (600 + 600 from ceil(500 * 1.2))
    const bondAfterBoth = app.db
      .prepare("SELECT outstanding_exposure_cents, status FROM bonds WHERE id = ?")
      .get(bondId) as { outstanding_exposure_cents: number; status: string };
    expect(bondAfterBoth.outstanding_exposure_cents).toBe(1200);
    expect(bondAfterBoth.status).toBe("occupied");

    // Resolve first action as success
    await resolveAction(app, resolverSigner, resolverId, action1Id, "success");

    // After resolving one: outstanding should be 600, status still "occupied"
    const bondAfterFirst = app.db
      .prepare("SELECT outstanding_exposure_cents, status FROM bonds WHERE id = ?")
      .get(bondId) as { outstanding_exposure_cents: number; status: string };
    expect(bondAfterFirst.outstanding_exposure_cents).toBe(600);
    expect(bondAfterFirst.status).toBe("occupied");

    // Resolve second action as success
    await resolveAction(app, resolverSigner, resolverId, action2Id, "success");

    // After resolving both: outstanding should be 0, status "released"
    const bondAfterSecond = app.db
      .prepare("SELECT outstanding_exposure_cents, status FROM bonds WHERE id = ?")
      .get(bondId) as { outstanding_exposure_cents: number; status: string };
    expect(bondAfterSecond.outstanding_exposure_cents).toBe(0);
    expect(bondAfterSecond.status).toBe("released");
  });

  it("final bond status keeps the most severe settled outcome across multiple actions", async () => {
    const app = await buildApp();
    const { identityId, signer } = await createIdentity(app);
    const { identityId: resolverId, signer: resolverSigner } = await createIdentity(app);

    const bondId = await lockBond(app, signer, identityId, 3000, "mixed-outcome bond");

    const action1Id = (await executeSignedAction(app, signer, {
      identityId,
      bondId,
      actionType: "mixed-malicious",
      payload: { n: 1 },
      exposure_cents: 500
    })).json().actionId as string;

    const action2Id = (await executeSignedAction(app, signer, {
      identityId,
      bondId,
      actionType: "mixed-success",
      payload: { n: 2 },
      exposure_cents: 500
    })).json().actionId as string;

    await resolveAction(app, resolverSigner, resolverId, action1Id, "malicious");
    await resolveAction(app, resolverSigner, resolverId, action2Id, "success");

    const bond = app.db
      .prepare("SELECT status, refund_cents, burned_cents, slashed_cents FROM bonds WHERE id = ?")
      .get(bondId) as { status: string; refund_cents: number; burned_cents: number; slashed_cents: number };

    expect(bond.status).toBe("slashed");
    expect(bond.refund_cents).toBe(600);
    expect(bond.burned_cents).toBe(0);
    expect(bond.slashed_cents).toBe(600);
  });

  it("failed outbound HTTP cleans up action and releases bond exposure", async () => {
    const app = await buildApp();
    const { identityId, signer } = await createIdentity(app);

    const bondId = await lockBond(app, signer, identityId, 1000, "outbound-fail-test");

    // Execute a market.http action with a URL not on the allowlist
    const actionBody = {
      identityId,
      bondId,
      actionType: "market.http",
      payload: { url: "https://evil.example.com/api", method: "POST", body: {} },
      exposure_cents: 500
    };
    const response = await executeSignedAction(app, signer, actionBody);

    // Should return an error
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("DESTINATION_BLOCKED");

    // Bond should be cleaned up — exposure back to 0, status back to "active"
    const bond = app.db
      .prepare("SELECT outstanding_exposure_cents, status FROM bonds WHERE id = ?")
      .get(bondId) as { outstanding_exposure_cents: number; status: string };
    expect(bond.outstanding_exposure_cents).toBe(0);
    expect(bond.status).toBe("active");

    // The stranded action should be marked "failed", not "open"
    const actions = app.db
      .prepare("SELECT status FROM actions WHERE bond_id = ?")
      .all(bondId) as Array<{ status: string }>;
    expect(actions).toHaveLength(1);
    expect(actions[0].status).toBe("failed");
  });
});

describe("Identity Governance", () => {
  it("banned identity cannot lock bond", async () => {
    const app = await buildApp();
    const { signer, identityId } = await createIdentity(app);

    await app.inject({
      method: "POST",
      url: "/admin/ban-identity",
      headers: { "x-agentgate-key": "test-key" },
      payload: { publicKey: signer.publicKey }
    });

    const lockPayload = { identityId, amountCents: 1000, currency: "USD", ttlSeconds: 300, reason: "ban test" };
    const response = await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      headers: { ...signHeaders(signer.privateKey, lockPayload, "/v1/bonds/lock") },
      payload: lockPayload
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("IDENTITY_BANNED");
  });

  it("banned identity cannot execute action", async () => {
    const app = await buildApp();
    const { signer, identityId } = await createIdentity(app);
    const bondId = await lockBond(app, signer, identityId, 1000, "pre-ban bond");

    await app.inject({
      method: "POST",
      url: "/admin/ban-identity",
      headers: { "x-agentgate-key": "test-key" },
      payload: { publicKey: signer.publicKey }
    });

    const actionBody = { identityId, actionType: "test-action", bondId, exposure_cents: 100 };
    const response = await executeSignedAction(app, signer, actionBody);

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("IDENTITY_BANNED");
  });

  it("banned identity cannot create a market", async () => {
    const app = await buildApp();
    const { signer, identityId } = await createIdentity(app);

    await app.inject({
      method: "POST",
      url: "/admin/ban-identity",
      headers: { "x-agentgate-key": "test-key" },
      payload: { publicKey: signer.publicKey }
    });

    const marketBody = {
      creatorId: identityId,
      question: "Will banned creators be blocked?",
      resolutionDeadline: new Date(Date.now() + 60_000).toISOString()
    };
    const response = await app.inject({
      method: "POST",
      url: "/markets",
      headers: signHeaders(signer.privateKey, marketBody, "/markets"),
      payload: marketBody
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("IDENTITY_BANNED");
  });

  it("banned identity cannot resolve a market it created", async () => {
    const app = await buildApp();
    const { signer, identityId } = await createIdentity(app);

    const marketBody = {
      creatorId: identityId,
      question: "Will banned resolvers be blocked?",
      resolutionDeadline: new Date(Date.now() + 60_000).toISOString()
    };
    const createResponse = await app.inject({
      method: "POST",
      url: "/markets",
      headers: signHeaders(signer.privateKey, marketBody, "/markets"),
      payload: marketBody
    });
    const { marketId } = createResponse.json() as { marketId: string };

    await app.inject({
      method: "POST",
      url: "/admin/ban-identity",
      headers: { "x-agentgate-key": "test-key" },
      payload: { publicKey: signer.publicKey }
    });

    const resolveBody = { outcome: "yes" as const, resolverId: identityId };
    const resolveUrl = `/markets/${marketId}/resolve`;
    const response = await app.inject({
      method: "POST",
      url: resolveUrl,
      headers: signHeaders(signer.privateKey, resolveBody, resolveUrl),
      payload: resolveBody
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("IDENTITY_BANNED");
  });

  it("admin can unban identity", async () => {
    const app = await buildApp();
    const { signer, identityId } = await createIdentity(app);

    await app.inject({
      method: "POST",
      url: "/admin/ban-identity",
      headers: { "x-agentgate-key": "test-key" },
      payload: { publicKey: signer.publicKey }
    });

    await app.inject({
      method: "POST",
      url: "/admin/unban-identity",
      headers: { "x-agentgate-key": "test-key" },
      payload: { publicKey: signer.publicKey }
    });

    const unbanLockPayload = { identityId, amountCents: 1000, currency: "USD", ttlSeconds: 300, reason: "post-unban bond" };
    const response = await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      headers: { ...signHeaders(signer.privateKey, unbanLockPayload, "/v1/bonds/lock") },
      payload: unbanLockPayload
    });

    expect(response.statusCode).toBe(201);
  });

  it("auto-bans identity after 3 malicious resolutions", async () => {
    const app = await buildApp();
    const { signer, identityId } = await createIdentity(app);
    const { identityId: resolverId, signer: resolverSigner } = await createIdentity(app);

    // Lock all 3 bonds upfront before any ban can trigger
    const bondId1 = await lockBond(app, signer, identityId, 10000, "malicious-bond-1");
    const bondId2 = await lockBond(app, signer, identityId, 10000, "malicious-bond-2");
    const bondId3 = await lockBond(app, signer, identityId, 10000, "malicious-bond-3");

    for (const bondId of [bondId1, bondId2, bondId3]) {
      const actionBody = { identityId, actionType: "bad-action", bondId, exposure_cents: 100 };
      const actionId = (await executeSignedAction(app, signer, actionBody)).json().actionId as string;

      await resolveAction(app, resolverSigner, resolverId, actionId, "malicious");
    }

    const postBanPayload = { identityId, amountCents: 1000, currency: "USD", ttlSeconds: 300, reason: "post-ban attempt" };
    const lockResponse = await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      headers: { ...signHeaders(signer.privateKey, postBanPayload, "/v1/bonds/lock") },
      payload: postBanPayload
    });

    expect(lockResponse.statusCode).toBe(403);
    expect(lockResponse.json().error).toBe("IDENTITY_BANNED");
  });

  it("ban/unban returns 404 for unknown identity", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/admin/ban-identity",
      headers: { "x-agentgate-key": "test-key" },
      payload: { publicKey: "dGhpcyBpcyBub3QgYSByZWFsIHB1YmxpY2tleQ==" }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("IDENTITY_NOT_FOUND");
  });
});

describe("nonce replay protection", () => {
  it("rejects duplicate nonce for same identity", async () => {
    const app = await buildApp();
    const { identityId, signer } = await createIdentity(app);
    const nonce = "replay-nonce-dup-dup-duplicate";

    const firstPayload = { identityId, amountCents: 500, currency: "USD", ttlSeconds: 300, reason: "first" };
    const first = await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      headers: signHeaders(signer.privateKey, firstPayload, "/v1/bonds/lock", undefined, nonce),
      payload: firstPayload
    });
    expect(first.statusCode).toBe(201);

    const secondPayload = { identityId, amountCents: 500, currency: "USD", ttlSeconds: 300, reason: "second" };
    const second = await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      headers: signHeaders(signer.privateKey, secondPayload, "/v1/bonds/lock", undefined, nonce),
      payload: secondPayload
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("DUPLICATE_NONCE");
  });

  it("allows different nonce for same identity", async () => {
    const app = await buildApp();
    const { identityId, signer } = await createIdentity(app);

    const firstPayload = { identityId, amountCents: 500, currency: "USD", ttlSeconds: 300, reason: "first" };
    const first = await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      headers: signHeaders(signer.privateKey, firstPayload, "/v1/bonds/lock", undefined, "aaa-aaa-aaa-aaa-aaa"),
      payload: firstPayload
    });
    expect(first.statusCode).toBe(201);

    const secondPayload = { identityId, amountCents: 500, currency: "USD", ttlSeconds: 300, reason: "second" };
    const second = await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      headers: signHeaders(signer.privateKey, secondPayload, "/v1/bonds/lock", undefined, "bbb-bbb-bbb-bbb-bbb"),
      payload: secondPayload
    });
    expect(second.statusCode).toBe(201);
  });

  it("rejects replayed identity registration nonce on subsequent request", async () => {
    const app = await buildApp();
    const signer = createSigner();
    const nonce = "identity-replay-nonce-test-1234";
    const payload = { publicKey: signer.publicKey };

    // Registration succeeds and records the nonce
    const first = await app.inject({
      method: "POST",
      url: "/v1/identities",
      headers: signHeaders(signer.privateKey, payload, "/v1/identities", undefined, nonce),
      payload
    });
    expect(first.statusCode).toBe(201);
    const { identityId } = first.json() as { identityId: string };

    // Attempt to reuse the same nonce on a bond lock — should be rejected
    const bondPayload = { identityId, amountCents: 500, currency: "USD", ttlSeconds: 300, reason: "replay" };
    const second = await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      headers: signHeaders(signer.privateKey, bondPayload, "/v1/bonds/lock", undefined, nonce),
      payload: bondPayload
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("DUPLICATE_NONCE");
  });

  it("allows same nonce from different identities", async () => {
    const app = await buildApp();
    const { identityId: identityId1, signer: signer1 } = await createIdentity(app);
    const { identityId: identityId2, signer: signer2 } = await createIdentity(app);
    const nonce = "shared-nonce-shared-nonce-shared";

    const firstPayload = { identityId: identityId1, amountCents: 500, currency: "USD", ttlSeconds: 300, reason: "identity1" };
    const first = await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      headers: signHeaders(signer1.privateKey, firstPayload, "/v1/bonds/lock", undefined, nonce),
      payload: firstPayload
    });
    expect(first.statusCode).toBe(201);

    const secondPayload = { identityId: identityId2, amountCents: 500, currency: "USD", ttlSeconds: 300, reason: "identity2" };
    const second = await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      headers: signHeaders(signer2.privateKey, secondPayload, "/v1/bonds/lock", undefined, nonce),
      payload: secondPayload
    });
    expect(second.statusCode).toBe(201);
  });
});

describe("identity registration", () => {
  it("rejects duplicate public key registration with 409 DUPLICATE_IDENTITY", async () => {
    const app = await buildApp();
    const signer = createSigner();
    const payload = { publicKey: signer.publicKey };

    const first = await app.inject({
      method: "POST",
      url: "/v1/identities",
      headers: { ...signHeaders(signer.privateKey, payload, "/v1/identities") },
      payload
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/v1/identities",
      headers: { ...signHeaders(signer.privateKey, payload, "/v1/identities") },
      payload
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("DUPLICATE_IDENTITY");
  });
});

describe("bond settlement fields", () => {
  it("persists refund_cents, burned_cents=0, and closed_at after successful resolution", async () => {
    const app = await buildApp();
    const signer = createSigner();
    const identityPayload = { publicKey: signer.publicKey };
    const idRes = await app.inject({
      method: "POST",
      url: "/v1/identities",
      headers: { ...signHeaders(signer.privateKey, identityPayload, "/v1/identities") },
      payload: identityPayload
    });
    const { identityId } = idRes.json() as { identityId: string };

    const { identityId: resolverId, signer: resolverSigner } = await createIdentity(app);

    const bondPayload = { identityId, amountCents: 1000, currency: "USD", ttlSeconds: 300, reason: "settlement-test-success" };
    const bondRes = await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      headers: { ...signHeaders(signer.privateKey, bondPayload, "/v1/bonds/lock") },
      payload: bondPayload
    });
    const { bondId } = bondRes.json() as { bondId: string };

    const actionPayload = { identityId, bondId, actionType: "settlement-test", exposure_cents: 500 };
    const actionRes = await app.inject({
      method: "POST",
      url: "/v1/actions/execute",
      headers: { ...signHeaders(signer.privateKey, actionPayload, "/v1/actions/execute") },
      payload: actionPayload
    });
    const { actionId } = actionRes.json() as { actionId: string };

    await resolveAction(app, resolverSigner, resolverId, actionId, "success");

    const bond = app.db
      .prepare(`SELECT refund_cents, burned_cents, closed_at, status FROM bonds WHERE id = ?`)
      .get(bondId) as { refund_cents: number; burned_cents: number; closed_at: string | null; status: string };

    // Effective exposure = ceil(500 * 1.2) = 600; success refunds the full effective exposure
    expect(bond.refund_cents).toBe(600);
    expect(bond.burned_cents).toBe(0);
    expect(bond.closed_at).toBeTruthy();
    expect(bond.status).toBe("released");
  });

  it("persists slashed_cents, burned_cents=0, refund_cents=0, and closed_at after malicious resolution", async () => {
    const app = await buildApp();
    const signer = createSigner();
    const identityPayload = { publicKey: signer.publicKey };
    const idRes = await app.inject({
      method: "POST",
      url: "/v1/identities",
      headers: { ...signHeaders(signer.privateKey, identityPayload, "/v1/identities") },
      payload: identityPayload
    });
    const { identityId } = idRes.json() as { identityId: string };

    const { identityId: resolverId, signer: resolverSigner } = await createIdentity(app);

    const bondPayload = { identityId, amountCents: 1000, currency: "USD", ttlSeconds: 300, reason: "settlement-test-malicious" };
    const bondRes = await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      headers: { ...signHeaders(signer.privateKey, bondPayload, "/v1/bonds/lock") },
      payload: bondPayload
    });
    const { bondId } = bondRes.json() as { bondId: string };

    const actionPayload = { identityId, bondId, actionType: "settlement-test", exposure_cents: 500 };
    const actionRes = await app.inject({
      method: "POST",
      url: "/v1/actions/execute",
      headers: { ...signHeaders(signer.privateKey, actionPayload, "/v1/actions/execute") },
      payload: actionPayload
    });
    const { actionId } = actionRes.json() as { actionId: string };

    await resolveAction(app, resolverSigner, resolverId, actionId, "malicious");

    const bond = app.db
      .prepare(`SELECT refund_cents, burned_cents, slashed_cents, closed_at, status FROM bonds WHERE id = ?`)
      .get(bondId) as { refund_cents: number; burned_cents: number; slashed_cents: number; closed_at: string | null; status: string };

    // Effective exposure = ceil(500 * 1.2) = 600; malicious slashes the full effective exposure
    expect(bond.refund_cents).toBe(0);
    expect(bond.burned_cents).toBe(0);
    expect(bond.slashed_cents).toBe(600);
    expect(bond.closed_at).toBeTruthy();
    expect(bond.status).toBe("slashed");
  });
});

describe("bond TTL cap", () => {
  it("rejects bond with ttl_seconds exceeding 86400", async () => {
    const app = await buildApp();
    const { signer, identityId } = await createIdentity(app);

    const payload = { identityId, amountCents: 1000, currency: "USD", ttlSeconds: 86401, reason: "too long" };
    const res = await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      headers: { ...signHeaders(signer.privateKey, payload, "/v1/bonds/lock") },
      payload
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("TTL_TOO_LONG");
    expect(res.json().message).toMatch(/TTL exceeds maximum/);
  });
});

describe("action payload size cap", () => {
  it("rejects execute request with payload exceeding 4096 characters", async () => {
    const app = await buildApp();
    const { signer, identityId } = await createIdentity(app);
    const bondId = await lockBond(app, signer, identityId, 1000, "payload-size-test");

    const oversizedPayload = { data: "x".repeat(4097) };
    const body = { identityId, bondId, actionType: "test", payload: oversizedPayload, exposure_cents: 100 };
    const res = await executeSignedAction(app, signer, body);

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("PAYLOAD_TOO_LARGE");
    expect(res.json().message).toMatch(/Payload exceeds maximum size/);
  });
});

describe("market endpoint signature verification", () => {
  it("rejects unsigned create market request", async () => {
    const app = await buildApp();
    const { identityId } = await createIdentity(app);

    const body = {
      creatorId: identityId,
      question: "Will it rain?",
      resolutionDeadline: new Date(Date.now() + 86400000).toISOString()
    };

    // No signature headers at all
    const res = await app.inject({
      method: "POST",
      url: "/markets",
      payload: body
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("MISSING_NONCE");
  });

  it("rejects unsigned resolve market request", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));

    const app = await buildApp();
    const { signer, identityId } = await createIdentity(app);

    const createBody = {
      creatorId: identityId,
      question: "Unsigned resolve test?",
      resolutionDeadline: "2026-03-01T12:00:02.000Z"
    };
    const createRes = await app.inject({
      method: "POST",
      url: "/markets",
      payload: createBody,
      headers: signHeaders(signer.privateKey, createBody, "/markets")
    });
    const { marketId } = createRes.json() as { marketId: string };

    // Advance past the deadline
    vi.setSystemTime(new Date("2026-03-01T12:00:03.000Z"));

    const resolveBody = { outcome: "yes" as const, resolverId: identityId };

    // No signature headers
    const res = await app.inject({
      method: "POST",
      url: `/markets/${marketId}/resolve`,
      payload: resolveBody
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("MISSING_NONCE");
  });

  it("rejects market resolution by a different identity than the creator", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));

    const app = await buildApp();
    const { signer: creatorSigner, identityId: creatorId } = await createIdentity(app);
    const { signer: otherSigner, identityId: otherId } = await createIdentity(app);

    // Creator creates the market
    const createBody = {
      creatorId,
      question: "Cross-identity resolve test?",
      resolutionDeadline: "2026-03-01T12:00:02.000Z"
    };
    const createRes = await app.inject({
      method: "POST",
      url: "/markets",
      payload: createBody,
      headers: signHeaders(creatorSigner.privateKey, createBody, "/markets")
    });
    expect(createRes.statusCode).toBe(201);
    const { marketId } = createRes.json() as { marketId: string };

    // Advance past the deadline
    vi.setSystemTime(new Date("2026-03-01T12:00:03.000Z"));

    // Other identity tries to resolve — should be rejected
    const resolveBody = { outcome: "yes" as const, resolverId: otherId };
    const resolveUrl = `/markets/${marketId}/resolve`;
    const resolveRes = await app.inject({
      method: "POST",
      url: resolveUrl,
      payload: resolveBody,
      headers: signHeaders(otherSigner.privateKey, resolveBody, resolveUrl)
    });

    expect(resolveRes.statusCode).toBe(403);
    expect(resolveRes.json().error).toBe("NOT_MARKET_CREATOR");

    // Creator can resolve successfully
    const creatorResolveBody = { outcome: "yes" as const, resolverId: creatorId };
    const creatorRes = await app.inject({
      method: "POST",
      url: resolveUrl,
      payload: creatorResolveBody,
      headers: signHeaders(creatorSigner.privateKey, creatorResolveBody, resolveUrl)
    });

    expect(creatorRes.statusCode).toBe(200);
    expect(creatorRes.json()).toMatchObject({ marketId, outcome: "yes" });
  });
});
