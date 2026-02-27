import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";

const apps: ReturnType<typeof createApp>[] = [];

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

    const firstIdentityId = (await app.inject({
      method: "POST",
      url: "/v1/identities",
      payload: { publicKey: "pk_stats_1" }
    })).json().identityId as string;

    const secondIdentityId = (await app.inject({
      method: "POST",
      url: "/v1/identities",
      payload: { publicKey: "pk_stats_2" }
    })).json().identityId as string;

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

    await app.inject({
      method: "POST",
      url: "/v1/actions/execute",
      payload: {
        identityId: secondIdentityId,
        actionType: "stats-action",
        payload: { note: "stats action" },
        bondId: usedBondId
      }
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

    const identityId = (await app.inject({
      method: "POST",
      url: "/v1/identities",
      payload: { publicKey: "pk_stats_resolution" }
    })).json().identityId as string;

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

    const actionId = (await app.inject({
      method: "POST",
      url: "/v1/actions/execute",
      payload: {
        identityId,
        actionType: "open-stats-action",
        payload: "open stats action",
        bondId
      }
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

    await app.inject({
      method: "POST",
      url: `/v1/actions/${actionId}/resolve`,
      payload: { outcome: "failed" }
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

    const identityResponse = await app.inject({
      method: "POST",
      url: "/v1/identities",
      payload: { publicKey: "pk_test_1" }
    });
    const identityId = identityResponse.json().identityId as string;

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

    const actionResponse = await app.inject({
      method: "POST",
      url: "/v1/actions/execute",
      payload: {
        identityId,
        actionType: "purchase-intent",
        payload: {
          note: "Ready to proceed"
        },
        bondId
      }
    });
    const actionId = actionResponse.json().actionId as string;

    const resolveResponse = await app.inject({
      method: "POST",
      url: `/v1/actions/${actionId}/resolve`,
      payload: { outcome: "success" }
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
      publicKey: "pk_test_1",
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

    const identityId = (await app.inject({
      method: "POST",
      url: "/v1/identities",
      payload: { publicKey: "pk_test_2" }
    })).json().identityId as string;

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

    const actionId = (await app.inject({
      method: "POST",
      url: "/v1/actions/execute",
      payload: {
        identityId,
        actionType: "timeout-action",
        payload: "Action with failure risk",
        bondId
      }
    })).json().actionId as string;

    const response = await app.inject({
      method: "POST",
      url: `/v1/actions/${actionId}/resolve`,
      payload: { outcome: "failed" }
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

    const identityId = (await app.inject({
      method: "POST",
      url: "/v1/identities",
      payload: { publicKey: "pk_test_3" }
    })).json().identityId as string;

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

    const actionId = (await app.inject({
      method: "POST",
      url: "/v1/actions/execute",
      payload: {
        identityId,
        actionType: "bad-faith-action",
        payload: {
          reason: "Bad faith action"
        },
        bondId
      }
    })).json().actionId as string;

    const response = await app.inject({
      method: "POST",
      url: `/v1/actions/${actionId}/resolve`,
      payload: { outcome: "malicious" }
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

    const identityId = (await app.inject({
      method: "POST",
      url: "/v1/identities",
      payload: { publicKey: "pk_test_4" }
    })).json().identityId as string;

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

    await app.inject({
      method: "POST",
      url: "/v1/actions/execute",
      payload: {
        identityId,
        actionType: "first-action",
        payload: "First action",
        bondId
      }
    });

    const secondActionResponse = await app.inject({
      method: "POST",
      url: "/v1/actions/execute",
      payload: {
        identityId,
        actionType: "second-action",
        payload: "Second action",
        bondId
      }
    });

    expect(secondActionResponse.statusCode).toBe(409);
    expect(secondActionResponse.json()).toEqual({
      error: "BOND_NOT_ACTIVE",
      message: "Bond is not active"
    });
  });
});
