import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject
} from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { createDatabase } from "../src/db";
import { AgentGateService } from "../src/service";

const apps: ReturnType<typeof createApp>[] = [];

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

function signHeaders(
  privateKey: KeyObject,
  body: Record<string, unknown>,
  url: string,
  timestamp = Date.now().toString(),
  nonce = randomUUID()
) {
  const message = createHash("sha256")
    .update(`${nonce}POST${url}${timestamp}${JSON.stringify(body)}`)
    .digest();
  return {
    "x-agentgate-timestamp": timestamp,
    "x-agentgate-signature": sign(null, message, privateKey).toString("base64"),
    "x-nonce": nonce
  };
}

async function buildApp() {
  const app = createApp({ dbPath: ":memory:" });
  apps.push(app);
  await app.ready();
  return app;
}

async function createIdentity(app: ReturnType<typeof createApp>) {
  const signer = createSigner();
  const payload = { publicKey: signer.publicKey };
  const response = await app.inject({
    method: "POST",
    url: "/v1/identities",
    headers: signHeaders(signer.privateKey, payload, "/v1/identities"),
    payload
  });
  return { signer, identityId: response.json().identityId as string };
}

async function lockBond(
  app: ReturnType<typeof createApp>,
  signer: { privateKey: KeyObject },
  identityId: string,
  amountCents: number
) {
  const payload = {
    identityId,
    amountCents,
    currency: "USD",
    ttlSeconds: 300,
    reason: "test"
  };
  return app.inject({
    method: "POST",
    url: "/v1/bonds/lock",
    headers: signHeaders(signer.privateKey, payload, "/v1/bonds/lock"),
    payload
  });
}

async function executeAction(
  app: ReturnType<typeof createApp>,
  signer: { privateKey: KeyObject },
  identityId: string,
  bondId: string,
  exposureCents: number
) {
  const body = {
    identityId,
    actionType: "test.action",
    bondId,
    exposure_cents: exposureCents
  };
  const res = await app.inject({
    method: "POST",
    url: "/v1/actions/execute",
    payload: body,
    headers: signHeaders(signer.privateKey, body, "/v1/actions/execute")
  });
  return res.json().actionId as string;
}

async function resolveAction(
  app: ReturnType<typeof createApp>,
  resolverSigner: { privateKey: KeyObject },
  resolverId: string,
  actionId: string,
  outcome: "success" | "failed" | "malicious"
) {
  const body = { outcome, resolverId };
  const url = `/v1/actions/${actionId}/resolve`;
  return app.inject({
    method: "POST",
    url,
    payload: body,
    headers: signHeaders(resolverSigner.privateKey, body, url)
  });
}

/** Seed N resolved actions directly into the database to build tier history.
 *  Avoids rate limits and progressive bond checks that would block HTTP-level setup. */
function seedSuccesses(app: ReturnType<typeof createApp>, identityId: string, count: number) {
  for (let i = 0; i < count; i++) {
    const bondId = `seed_bond_${randomUUID()}`;
    const resolverId = `seed_resolver_${i}`;
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 300_000).toISOString();
    (app as any).db.prepare(
      `INSERT INTO bonds (id, identity_id, amount_cents, currency, ttl_seconds, reason, status, expires_at, created_at)
       VALUES (?, ?, 100, 'USD', 300, 'seed', 'released', ?, ?)`
    ).run(bondId, identityId, expires, now);
    (app as any).db.prepare(
      `INSERT INTO actions (
         id, identity_id, action_type, bond_id, exposure_cents, status,
         created_at, resolved_at, resolved_by_identity_id
       ) VALUES (?, ?, 'seed', ?, 100, 'success', ?, ?, ?)`
    ).run(`seed_action_${randomUUID()}`, identityId, bondId, now, now, resolverId);
  }
}

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    if (app) await app.close();
  }
});

describe("trust tier bond cap enforcement", () => {
  it("Tier 1 identity rejected when requesting 200¢ bond", async () => {
    const app = await buildApp();
    const { signer, identityId } = await createIdentity(app);

    const res = await lockBond(app, signer, identityId, 200);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("TIER_BOND_CAP_EXCEEDED");
  });

  it("Tier 1 identity allowed when requesting 100¢ bond", async () => {
    const app = await buildApp();
    const { signer, identityId } = await createIdentity(app);

    const res = await lockBond(app, signer, identityId, 100);
    expect(res.statusCode).toBe(201);
    expect(res.json().bondId).toBeDefined();
  });

  it("Tier 2 identity allowed when requesting 500¢ bond", async () => {
    const app = await buildApp();
    const { signer, identityId } = await createIdentity(app);

    // Build 5 successes to reach Tier 2
    seedSuccesses(app, identityId, 5);

    const res = await lockBond(app, signer, identityId, 500);
    expect(res.statusCode).toBe(201);
    expect(res.json().bondId).toBeDefined();
  });

  it("Tier 2 identity rejected when requesting 501¢ bond", async () => {
    const app = await buildApp();
    const { signer, identityId } = await createIdentity(app);

    seedSuccesses(app, identityId, 5);

    const res = await lockBond(app, signer, identityId, 501);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("TIER_BOND_CAP_EXCEEDED");
  });

  it("Tier 3 identity allowed when requesting bond above 500¢", async () => {
    const app = await buildApp();
    const { signer, identityId } = await createIdentity(app);

    // Build 20 successes to reach Tier 3
    seedSuccesses(app, identityId, 20);

    // Tier 3 removes tier cap — request 1000¢ bond
    const res = await lockBond(app, signer, identityId, 1000);
    expect(res.statusCode).toBe(201);
    expect(res.json().bondId).toBeDefined();
  });
});

describe("trust tier demotion flow (service layer)", () => {
  let service: AgentGateService;
  let closeDb: () => void;

  beforeEach(() => {
    const { db, close } = createDatabase(":memory:");
    service = new AgentGateService(db);
    closeDb = close;
  });

  afterEach(() => {
    closeDb();
  });

  it("Tier 3 identity demoted to Tier 1 after a finalized malicious resolution", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-28T12:00:00.000Z"));

    const { identityId } = service.createIdentity({ publicKey: `DEMOTION_TEST_${randomUUID().slice(0, 30)}=` });
    const resolverIds = Array.from({ length: 20 }, () =>
      service.createIdentity({ publicKey: `RESOLVER_${randomUUID().slice(0, 30)}=` }).identityId
    );
    const maliciousResolverIds = Array.from({ length: 2 }, () =>
      service.createIdentity({
        publicKey: `MALICIOUS_RESOLVER_${randomUUID().slice(0, 30)}=`
      }).identityId
    );

    // Build 20 successful resolutions to reach Tier 3
    // Advance time by 11+ minutes every 10 actions to clear both rate limit
    // and progressive min bond windows (10 min each)
    for (let i = 0; i < 20; i++) {
      if (i > 0 && i % 10 === 0) {
        vi.setSystemTime(new Date(`2026-03-28T${12 + Math.floor(i / 10)}:00:00.000Z`));
      }
      const { bondId } = service.lockBond({
        identityId, amountCents: 100, currency: "USD", ttlSeconds: 3600,
        reason: `tier-build-${i}`
      });
      const { actionId } = await service.executeAction({
        identityId, bondId, actionType: "tier-build",
        exposure_cents: 83
      });
      service.resolveAction(actionId, { outcome: "success", resolverId: resolverIds[i] });
    }

    // Advance time past both rate limit and progressive min bond windows
    vi.setSystemTime(new Date("2026-03-28T14:00:00.000Z"));

    // Verify identity is Tier 3 — can lock a 1000¢ bond
    const { bondId: largeBondId } = service.lockBond({
      identityId, amountCents: 1000, currency: "USD", ttlSeconds: 300,
      reason: "tier-3-confirmed"
    });
    expect(largeBondId).toMatch(/^bond_/);

    // Execute and resolve one action as malicious
    const { actionId: maliciousActionId } = await service.executeAction({
      identityId, bondId: largeBondId, actionType: "malicious-act",
      exposure_cents: 10
    });
    const pendingResult = service.resolveAction(maliciousActionId, {
      outcome: "malicious",
      resolverId: maliciousResolverIds[0]
    });
    expect(pendingResult).toMatchObject({
      outcome: "malicious",
      finalized: false,
      maliciousVotes: 1,
      maliciousVotesRequired: 2
    });
    service.resolveAction(maliciousActionId, {
      outcome: "malicious",
      resolverId: maliciousResolverIds[1]
    });

    // Verify identity is now Tier 1 — cannot lock a bond above 100¢
    expect(() => service.lockBond({
      identityId, amountCents: 200, currency: "USD", ttlSeconds: 300,
      reason: "post-demotion-attempt"
    })).toThrow(/Tier 1/);

    // Can still lock a 100¢ bond (Tier 1 cap)
    const { bondId: smallBondId } = service.lockBond({
      identityId, amountCents: 100, currency: "USD", ttlSeconds: 300,
      reason: "post-demotion-small"
    });
    expect(smallBondId).toMatch(/^bond_/);

    vi.useRealTimers();
  });

  it("trivial low-exposure wins do not advance trust tier", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-28T12:00:00.000Z"));

    const { identityId } = service.createIdentity({ publicKey: `FARMING_TEST_${randomUUID().slice(0, 30)}=` });
    const resolverIds = Array.from({ length: 20 }, () =>
      service.createIdentity({ publicKey: `FARM_RESOLVER_${randomUUID().slice(0, 30)}=` }).identityId
    );

    // Low-exposure successes should not count toward tier promotion, even when
    // the resolutions come from different identities.
    for (let i = 0; i < 20; i++) {
      if (i > 0 && i % 10 === 0) {
        vi.setSystemTime(new Date(`2026-03-28T${12 + Math.floor(i / 10)}:00:00.000Z`));
      }
      const { bondId } = service.lockBond({
        identityId, amountCents: 2, currency: "USD", ttlSeconds: 3600,
        reason: `cheap-farm-${i}`
      });
      const { actionId } = await service.executeAction({
        identityId, bondId, actionType: "cheap-farm",
        exposure_cents: 1
      });
      service.resolveAction(actionId, {
        outcome: "success",
        resolverId: resolverIds[i]
      });
    }

    // Advance time past both rate limit and progressive min bond windows
    vi.setSystemTime(new Date("2026-03-28T14:00:00.000Z"));

    expect(() => service.lockBond({
      identityId, amountCents: 200, currency: "USD", ttlSeconds: 300,
      reason: "still-tier-1"
    })).toThrow(/Tier 1/);

    // Reputation stats still reflect the successful outcomes; only the trust tier
    // ignores them because the resolved exposure was too small to qualify.
    const stats = service.getIdentitySummary(identityId);
    expect(stats.reputation.stats.successes).toBe(20);
    expect(stats.reputation.stats.malicious).toBe(0);

    vi.useRealTimers();
  });
});
