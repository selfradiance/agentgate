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
  it("refunds 100% for accepted offers and updates identity stats", async () => {
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

    const offerResponse = await app.inject({
      method: "POST",
      url: "/v1/offers",
      payload: {
        identityId,
        listingId: "listing-123",
        priceCents: 25000,
        message: "Ready to proceed",
        bondId
      }
    });
    const offerId = offerResponse.json().offerId as string;

    const resolveResponse = await app.inject({
      method: "POST",
      url: `/v1/offers/${offerId}/resolve`,
      payload: { outcome: "accepted" }
    });

    expect(resolveResponse.statusCode).toBe(200);
    expect(resolveResponse.json()).toMatchObject({
      offerId,
      outcome: "accepted",
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
          offers: 1,
          accepts: 1,
          rejects: 0,
          expires: 0,
          slashes: 0
        }
      }
    });
  });

  it("burns 5% on expired offers", async () => {
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

    const offerId = (await app.inject({
      method: "POST",
      url: "/v1/offers",
      payload: {
        identityId,
        listingId: "listing-456",
        priceCents: 1200,
        message: "Offer with expiry risk",
        bondId
      }
    })).json().offerId as string;

    const response = await app.inject({
      method: "POST",
      url: `/v1/offers/${offerId}/resolve`,
      payload: { outcome: "expired" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      outcome: "expired",
      refundCents: 949,
      burnedCents: 50,
      slashedCents: 0
    });
  });

  it("defaults malicious resolution to a full slash", async () => {
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

    const offerId = (await app.inject({
      method: "POST",
      url: "/v1/offers",
      payload: {
        identityId,
        listingId: "listing-789",
        priceCents: 4500,
        message: "Bad faith offer",
        bondId
      }
    })).json().offerId as string;

    const response = await app.inject({
      method: "POST",
      url: `/v1/offers/${offerId}/resolve`,
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

  it("rejects offers that reference inactive bonds", async () => {
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
      url: "/v1/offers",
      payload: {
        identityId,
        listingId: "listing-001",
        priceCents: 1200,
        message: "First offer",
        bondId
      }
    });

    const secondOfferResponse = await app.inject({
      method: "POST",
      url: "/v1/offers",
      payload: {
        identityId,
        listingId: "listing-002",
        priceCents: 1300,
        message: "Second offer",
        bondId
      }
    });

    expect(secondOfferResponse.statusCode).toBe(409);
    expect(secondOfferResponse.json()).toEqual({
      error: "BOND_NOT_ACTIVE",
      message: "Bond is not active"
    });
  });
});
