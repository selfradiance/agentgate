import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject
} from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
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

async function buildApp() {
  const app = createApp({ dbPath: ":memory:" });
  apps.push(app);
  await app.ready();
  return app;
}

afterEach(async () => {
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

    const activeBondId = (await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      payload: {
        identityId: firstIdentityId,
        amountCents: 1000,
        currency: "USD",
        ttlSeconds: 300,
        reason: "active stats bond"
      }
    })).json().bondId as string;

    const usedBondId = (await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      payload: {
        identityId: secondIdentityId,
        amountCents: 2000,
        currency: "USD",
        ttlSeconds: 300,
        reason: "used stats bond"
      }
    })).json().bondId as string;

    const actionBody = {
      identityId: secondIdentityId,
      actionType: "stats-action",
      payload: { note: "stats action" },
      bondId: usedBondId
    };

    await app.inject({
      method: "POST",
      url: "/v1/actions/execute",
      payload: actionBody,
      headers: signHeaders(signer.privateKey, actionBody)
    });

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

    const bondId = (await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      payload: {
        identityId,
        amountCents: 1500,
        currency: "USD",
        ttlSeconds: 300,
        reason: "resolution stats bond"
      }
    })).json().bondId as string;

    const actionBody = {
      identityId,
      actionType: "open-stats-action",
      payload: "open stats action",
      bondId
    };

    const actionId = (await app.inject({
      method: "POST",
      url: "/v1/actions/execute",
      payload: actionBody,
      headers: signHeaders(signer.privateKey, actionBody)
    })).json().actionId as string;

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

    const bondResponse = await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      payload: {
        identityId,
        amountCents: 1000,
        currency: "usd",
        ttlSeconds: 300,
        reason: "serious intent"
      }
    });
    const bondId = bondResponse.json().bondId as string;

    const actionBody = {
      identityId,
      actionType: "purchase-intent",
      payload: {
        note: "Ready to proceed"
      },
      bondId
    };

    const actionResponse = await app.inject({
      method: "POST",
      url: "/v1/actions/execute",
      payload: actionBody,
      headers: signHeaders(signer.privateKey, actionBody)
    });
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

    const bondId = (await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      payload: {
        identityId,
        amountCents: 999,
        currency: "USD",
        ttlSeconds: 300,
        reason: "holding bond"
      }
    })).json().bondId as string;

    const actionBody = {
      identityId,
      actionType: "timeout-action",
      payload: "Action with failure risk",
      bondId
    };

    const actionId = (await app.inject({
      method: "POST",
      url: "/v1/actions/execute",
      payload: actionBody,
      headers: signHeaders(signer.privateKey, actionBody)
    })).json().actionId as string;

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

    const bondId = (await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      payload: {
        identityId,
        amountCents: 5000,
        currency: "USD",
        ttlSeconds: 300,
        reason: "spam deterrence"
      }
    })).json().bondId as string;

    const actionBody = {
      identityId,
      actionType: "bad-faith-action",
      payload: {
        reason: "Bad faith action"
      },
      bondId
    };

    const actionId = (await app.inject({
      method: "POST",
      url: "/v1/actions/execute",
      payload: actionBody,
      headers: signHeaders(signer.privateKey, actionBody)
    })).json().actionId as string;

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

    const bondId = (await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      payload: {
        identityId,
        amountCents: 1200,
        currency: "USD",
        ttlSeconds: 300,
        reason: "single use bond"
      }
    })).json().bondId as string;

    const firstActionBody = {
      identityId,
      actionType: "first-action",
      payload: "First action",
      bondId
    };

    await app.inject({
      method: "POST",
      url: "/v1/actions/execute",
      payload: firstActionBody,
      headers: signHeaders(signer.privateKey, firstActionBody)
    });

    const secondActionBody = {
      identityId,
      actionType: "second-action",
      payload: "Second action",
      bondId
    };

    const secondActionResponse = await app.inject({
      method: "POST",
      url: "/v1/actions/execute",
      payload: secondActionBody,
      headers: signHeaders(signer.privateKey, secondActionBody)
    });

    expect(secondActionResponse.statusCode).toBe(409);
    expect(secondActionResponse.json()).toEqual({
      error: "BOND_NOT_ACTIVE",
      message: "Bond is not active"
    });
  });

  it("accepts signed action execution using the caller's body field order", async () => {
    const app = await buildApp();

    const { identityId, signer } = await createIdentity(app);

    const bondId = (await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      payload: {
        identityId,
        amountCents: 1000,
        currency: "USD",
        ttlSeconds: 300,
        reason: "field order"
      }
    })).json().bondId as string;

    const actionBody = {
      bondId,
      payload: { note: "different order" },
      actionType: "ordered-action",
      identityId
    };

    const response = await app.inject({
      method: "POST",
      url: "/v1/actions/execute",
      payload: actionBody,
      headers: signHeaders(signer.privateKey, actionBody)
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      status: "open"
    });
  });

  it("rejects action execution with an invalid signature", async () => {
    const app = await buildApp();

    const { identityId } = await createIdentity(app);
    const wrongSigner = createSigner();

    const bondId = (await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      payload: {
        identityId,
        amountCents: 1000,
        currency: "USD",
        ttlSeconds: 300,
        reason: "signed request"
      }
    })).json().bondId as string;

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

    const bondId = (await app.inject({
      method: "POST",
      url: "/v1/bonds/lock",
      payload: {
        identityId,
        amountCents: 1000,
        currency: "USD",
        ttlSeconds: 300,
        reason: "stale signature"
      }
    })).json().bondId as string;

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
});
