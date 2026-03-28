import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppInstance } from "../src/app";
import { registerDashboard } from "../src/dashboard";

const apps: AppInstance[] = [];

async function buildApp() {
  const app = createApp({ dbPath: ":memory:" });
  registerDashboard(app);
  apps.push(app);
  await app.ready();
  return app;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  while (apps.length > 0) {
    await apps.pop()?.close();
  }
});

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

describe("dashboard basic auth", () => {
  it("correct username and password succeeds", async () => {
    vi.stubEnv("AGENTGATE_DASHBOARD_KEY", "test-secret");
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { authorization: basicAuth("admin", "test-secret") }
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("wrong username with correct password is rejected", async () => {
    vi.stubEnv("AGENTGATE_DASHBOARD_KEY", "test-secret");
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { authorization: basicAuth("hacker", "test-secret") }
    });

    expect(res.statusCode).toBe(401);
  });

  it("correct username with wrong password is rejected", async () => {
    vi.stubEnv("AGENTGATE_DASHBOARD_KEY", "test-secret");
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { authorization: basicAuth("admin", "wrong-password") }
    });

    expect(res.statusCode).toBe(401);
  });

  it("returns 500 when AGENTGATE_DASHBOARD_KEY is unset and dev mode is off", async () => {
    vi.stubEnv("AGENTGATE_DEV_MODE", "false");
    delete process.env.AGENTGATE_DASHBOARD_KEY;
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { authorization: basicAuth("admin", "anything") }
    });

    expect(res.statusCode).toBe(500);
  });
});

describe("dashboard trust tier display", () => {
  function seedIdentity(app: AppInstance, id: string) {
    const pk = `DASHBOARD_TEST_${randomUUID().slice(0, 28)}==`;
    (app as any).db.prepare(
      `INSERT INTO identities (id, public_key, status, created_at) VALUES (?, ?, 'active', ?)`
    ).run(id, pk, new Date().toISOString());
  }

  function seedResolvedAction(app: AppInstance, identityId: string, status: string) {
    const bondId = `bond_${randomUUID()}`;
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 300_000).toISOString();
    (app as any).db.prepare(
      `INSERT INTO bonds (id, identity_id, amount_cents, currency, ttl_seconds, reason, status, expires_at, created_at)
       VALUES (?, ?, 100, 'USD', 300, 'seed', 'released', ?, ?)`
    ).run(bondId, identityId, expires, now);
    (app as any).db.prepare(
      `INSERT INTO actions (id, identity_id, action_type, bond_id, exposure_cents, status, created_at, resolved_at)
       VALUES (?, ?, 'seed', ?, 10, ?, ?, ?)`
    ).run(`action_${randomUUID()}`, identityId, bondId, status, now, now);
  }

  it("new identity shows Tier 1 (New)", async () => {
    vi.stubEnv("AGENTGATE_DEV_MODE", "true");
    const app = await buildApp();
    seedIdentity(app, "id_tier1_test");

    const res = await app.inject({ method: "GET", url: "/dashboard" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Tier 1 (New)");
  });

  it("identity with 5 successes shows Tier 2 (Established)", async () => {
    vi.stubEnv("AGENTGATE_DEV_MODE", "true");
    const app = await buildApp();
    const id = "id_tier2_test";
    seedIdentity(app, id);
    for (let i = 0; i < 5; i++) seedResolvedAction(app, id, "success");

    const res = await app.inject({ method: "GET", url: "/dashboard" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Tier 2 (Established)");
  });

  it("identity with 20 successes shows Tier 3 (Trusted)", async () => {
    vi.stubEnv("AGENTGATE_DEV_MODE", "true");
    const app = await buildApp();
    const id = "id_tier3_test";
    seedIdentity(app, id);
    for (let i = 0; i < 20; i++) seedResolvedAction(app, id, "success");

    const res = await app.inject({ method: "GET", url: "/dashboard" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Tier 3 (Trusted)");
  });

  it("two identities at different tiers each show correct label", async () => {
    vi.stubEnv("AGENTGATE_DEV_MODE", "true");
    const app = await buildApp();

    seedIdentity(app, "id_new_agent");
    // no actions — stays Tier 1

    const tier2Id = "id_established_agent";
    seedIdentity(app, tier2Id);
    for (let i = 0; i < 5; i++) seedResolvedAction(app, tier2Id, "success");

    const res = await app.inject({ method: "GET", url: "/dashboard" });
    expect(res.statusCode).toBe(200);

    // Find the row containing each identity and verify its tier label
    const rows = res.body.split("<tr>").filter((r: string) => r.includes("id_new_agent") || r.includes("id_established"));
    const newRow = rows.find((r: string) => r.includes("id_new_agent"));
    const estRow = rows.find((r: string) => r.includes("id_established"));
    expect(newRow).toContain("Tier 1 (New)");
    expect(estRow).toContain("Tier 2 (Established)");
  });

  it("dashboard has tier column header", async () => {
    vi.stubEnv("AGENTGATE_DEV_MODE", "true");
    const app = await buildApp();
    seedIdentity(app, "id_header_test");

    const res = await app.inject({ method: "GET", url: "/dashboard" });
    expect(res.body).toContain("<th>tier</th>");
  });
});
