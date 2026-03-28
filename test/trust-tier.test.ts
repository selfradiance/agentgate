import {
  createHash,
  generateKeyPairSync,
  randomUUID,
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
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 300_000).toISOString();
    (app as any).db.prepare(
      `INSERT INTO bonds (id, identity_id, amount_cents, currency, ttl_seconds, reason, status, expires_at, created_at)
       VALUES (?, ?, 100, 'USD', 300, 'seed', 'released', ?, ?)`
    ).run(bondId, identityId, expires, now);
    (app as any).db.prepare(
      `INSERT INTO actions (id, identity_id, action_type, bond_id, exposure_cents, status, created_at, resolved_at)
       VALUES (?, ?, 'seed', ?, 12, 'success', ?, ?)`
    ).run(`seed_action_${randomUUID()}`, identityId, bondId, now, now);
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
