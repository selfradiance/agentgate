import {
  createHash,
  generateKeyPairSync,
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

function signHeaders(privateKey: KeyObject, body: Record<string, unknown>, timestamp = Date.now().toString()) {
  const message = createHash("sha256").update(`${timestamp}${JSON.stringify(body)}`).digest();

  return {
    "x-agentgate-timestamp": timestamp,
    "x-agentgate-signature": sign(null, message, privateKey).toString("base64")
  };
}

async function createIdentity(app: ReturnType<typeof createApp>) {
  const signer = createSigner();
  const response = await app.inject({
    method: "POST",
    url: "/v1/identities",
    payload: { publicKey: signer.publicKey }
  });

  return {
    signer,
    identityId: response.json().identityId as string
  };
}

async function lockBond(
  app: ReturnType<typeof createApp>,
  identityId: string,
  amountCents: number,
  reason: string
) {
  return (await app.inject({
    method: "POST",
    url: "/v1/bonds/lock",
    payload: {
      identityId,
      amountCents,
      currency: "USD",
      ttlSeconds: 300,
      reason
    }
  })).json().bondId as string;
}

async function executeSignedAction(
  app: ReturnType<typeof createApp>,
  signer: { privateKey: KeyObject },
  body: Record<string, unknown>
) {
  return app.inject({
    method: "POST",
    url: "/v1/actions/execute",
    payload: body,
    headers: signHeaders(signer.privateKey, body)
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

    const { identityId: firstIdentityId } = await createIdentity(app);
    const { identityId: secondIdentityId, signer } = await createIdentity(app);

    const activeBondId = await lockBond(app, firstIdentityId, 1000, "active stats bond");
    const usedBondId = await lockBond(app, secondIdentityId, 2000, "used stats bond");

    const actionBody = {
      identityId: secondIdentityId,
      actionType: "stats-action",
      payload: { note: "stats action" },
      bondId: usedBondId
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

    const bondId = await lockBond(app, identityId, 1500, "resolution stats bond");

    const actionBody = {
      identityId,
      actionType: "open-stats-action",
      payload: "open stats action",
      bondId
    };

    const actionId = (await executeSignedAction(app, signer, actionBody)).json().actionId as string;

    const openStatsResponse = await app.inject({
      method: "GET",
      url: "/v1/stats"
    });

    expect(openStatsResponse.json()).toEqual({
      totalIdentities: 1,
      totalActions: 1,
      totalActiveBonds: 1,
      totalLockedCents: 1500
    });

    const resolveBody = { outcome: "failed" as const };

    await app.inject({
      method: "POST",
      url: `/v1/actions/${actionId}/resolve`,
      payload: resolveBody,
      headers: signHeaders(signer.privateKey, resolveBody)
    });

    const resolvedStatsResponse = await app.inject({
      method: "GET",
      url: "/v1/stats"
    });

    expect(resolvedStatsResponse.json()).toEqual({
      totalIdentities: 1,
      totalActions: 1,
      totalActiveBonds: 0,
      totalLockedCents: 0
    });
  });

  it("refunds 100% for successful actions and updates identity stats", async () => {
    const app = await buildApp();

    const { identityId, signer } = await createIdentity(app);

    const bondId = await lockBond(app, identityId, 1000, "serious intent");

    const actionBody = {
      identityId,
      actionType: "purchase-intent",
      payload: {
        note: "Ready to proceed"
      },
      bondId
    };

    const actionResponse = await executeSignedAction(app, signer, actionBody);
    const actionId = actionResponse.json().actionId as string;

    const resolveBody = { outcome: "success" as const };
    const resolveResponse = await app.inject({
      method: "POST",
      url: `/v1/actions/${actionId}/resolve`,
      payload: resolveBody,
      headers: signHeaders(signer.privateKey, resolveBody)
    });

    expect(resolveResponse.statusCode).toBe(200);
    expect(resolveResponse.json()).toMatchObject({
      actionId,
      outcome: "success",
      refundCents: 1000,
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

    const bondId = await lockBond(app, identityId, 999, "holding bond");

    const actionBody = {
      identityId,
      actionType: "timeout-action",
      payload: "Action with failure risk",
      bondId
    };

    const actionId = (await executeSignedAction(app, signer, actionBody)).json().actionId as string;

    const resolveBody = { outcome: "failed" as const };
    const response = await app.inject({
      method: "POST",
      url: `/v1/actions/${actionId}/resolve`,
      payload: resolveBody,
      headers: signHeaders(signer.privateKey, resolveBody)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      outcome: "failed",
      refundCents: 949,
      burnedCents: 50,
      slashedCents: 0
    });
  });

  it("slashes 100% for malicious actions", async () => {
    const app = await buildApp();

    const { identityId, signer } = await createIdentity(app);

    const bondId = await lockBond(app, identityId, 5000, "spam deterrence");

    const actionBody = {
      identityId,
      actionType: "bad-faith-action",
      payload: {
        reason: "Bad faith action"
      },
      bondId
    };

    const actionId = (await executeSignedAction(app, signer, actionBody)).json().actionId as string;

    const resolveBody = { outcome: "malicious" as const };
    const response = await app.inject({
      method: "POST",
      url: `/v1/actions/${actionId}/resolve`,
      payload: resolveBody,
      headers: signHeaders(signer.privateKey, resolveBody)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      outcome: "malicious",
      refundCents: 0,
      burnedCents: 0,
      slashedCents: 5000
    });
  });

  it("rejects actions that reference inactive bonds", async () => {
    const app = await buildApp();

    const { identityId, signer } = await createIdentity(app);

    const bondId = await lockBond(app, identityId, 1200, "single use bond");

    const firstActionBody = {
      identityId,
      actionType: "first-action",
      payload: "First action",
      bondId
    };

    await executeSignedAction(app, signer, firstActionBody);

    const secondActionBody = {
      identityId,
      actionType: "second-action",
      payload: "Second action",
      bondId
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

    const bondId = await lockBond(app, identityId, 1000, "field order");

    const actionBody = {
      bondId,
      payload: { note: "different order" },
      actionType: "ordered-action",
      identityId
    };

    const response = await executeSignedAction(app, signer, actionBody);

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      status: "open"
    });
  });

  it("rejects action execution with an invalid signature", async () => {
    const app = await buildApp();

    const { identityId } = await createIdentity(app);
    const wrongSigner = createSigner();

    const bondId = await lockBond(app, identityId, 1000, "signed request");

    const actionBody = {
      identityId,
      actionType: "signed-action",
      payload: { note: "wrong signer" },
      bondId
    };

    const response = await app.inject({
      method: "POST",
      url: "/v1/actions/execute",
      payload: actionBody,
      headers: signHeaders(wrongSigner.privateKey, actionBody)
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

    const bondId = await lockBond(app, identityId, 1000, "stale signature");

    const actionBody = {
      identityId,
      actionType: "stale-action",
      payload: { note: "stale" },
      bondId
    };

    const response = await app.inject({
      method: "POST",
      url: "/v1/actions/execute",
      payload: actionBody,
      headers: signHeaders(signer.privateKey, actionBody, `${Date.now() - 61_000}`)
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
      const bondId = await lockBond(app, identityId, 1000, `rate-limit-${index}`);
      const response = await executeSignedAction(app, signer, {
        identityId,
        bondId,
        actionType: "rate-limit-action",
        payload: { attempt: index + 1 }
      });

      expect(response.statusCode).toBe(201);
    }

    const bondId = await lockBond(app, identityId, 1000, "rate-limit-11");
    const response = await executeSignedAction(app, signer, {
      identityId,
      bondId,
      actionType: "rate-limit-action",
      payload: { attempt: 11 }
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
      const bondId = await lockBond(app, identityId, 1000, `progressive-a-${index}`);
      const response = await executeSignedAction(app, signer, {
        identityId,
        bondId,
        actionType: "progressive-action",
        payload: { attempt: index + 1 }
      });

      expect(response.statusCode).toBe(201);
    }

    vi.setSystemTime(new Date("2026-02-27T12:01:01.000Z"));

    const eleventhBondId = await lockBond(app, identityId, 1000, "progressive-a-11");
    const eleventhResponse = await executeSignedAction(app, signer, {
      identityId,
      bondId: eleventhBondId,
      actionType: "progressive-action",
      payload: { attempt: 11 }
    });

    expect(eleventhResponse.statusCode).toBe(201);

    const tooSmallBondId = await lockBond(app, identityId, 1000, "progressive-too-small-2000");
    const tooSmallResponse = await executeSignedAction(app, signer, {
      identityId,
      bondId: tooSmallBondId,
      actionType: "progressive-action",
      payload: { attempt: 12 }
    });

    expect(tooSmallResponse.statusCode).toBe(409);
    expect(tooSmallResponse.json()).toEqual({
      error: "MIN_BOND_REQUIRED",
      message: "Minimum bond is 2000 cents for this identity's recent action volume"
    });

    const validMidBondId = await lockBond(app, identityId, 2000, "progressive-valid-2000");
    const validMidResponse = await executeSignedAction(app, signer, {
      identityId,
      bondId: validMidBondId,
      actionType: "progressive-action",
      payload: { attempt: 13 }
    });

    expect(validMidResponse.statusCode).toBe(201);

    vi.setSystemTime(new Date("2026-02-27T12:02:02.000Z"));

    for (let index = 0; index < 8; index += 1) {
      const bondId = await lockBond(app, identityId, 2000, `progressive-b-${index}`);
      const response = await executeSignedAction(app, signer, {
        identityId,
        bondId,
        actionType: "progressive-action",
        payload: { attempt: 14 + index }
      });

      expect(response.statusCode).toBe(201);
    }

    vi.setSystemTime(new Date("2026-02-27T12:03:03.000Z"));

    const thresholdBondId = await lockBond(app, identityId, 2000, "progressive-threshold-2000");
    const thresholdResponse = await executeSignedAction(app, signer, {
      identityId,
      bondId: thresholdBondId,
      actionType: "progressive-action",
      payload: { attempt: 22 }
    });

    expect(thresholdResponse.statusCode).toBe(201);

    const tooSmallHighBondId = await lockBond(app, identityId, 4000, "progressive-too-small-5000");
    const tooSmallHighResponse = await executeSignedAction(app, signer, {
      identityId,
      bondId: tooSmallHighBondId,
      actionType: "progressive-action",
      payload: { attempt: 23 }
    });

    expect(tooSmallHighResponse.statusCode).toBe(409);
    expect(tooSmallHighResponse.json()).toEqual({
      error: "MIN_BOND_REQUIRED",
      message: "Minimum bond is 5000 cents for this identity's recent action volume"
    });
  });
});
