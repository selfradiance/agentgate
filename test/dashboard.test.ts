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
