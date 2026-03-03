// src/http.ts
import { createLogger } from "./logger";
const DEFAULT_TIMEOUT_MS = Number(process.env.AGENTGATE_HTTP_TIMEOUT_MS || 2500);
const DEFAULT_MAX_RESPONSE_BYTES = Number(process.env.AGENTGATE_HTTP_MAX_RESPONSE_BYTES || 8192);
// Comma-separated list, optional (e.g. "localhost,127.0.0.1")
// If not provided, we default to localhost-only.
const ALLOWLIST_ENV = (process.env.AGENTGATE_HTTP_ALLOWLIST || "").trim();

function buildAllowlist(): Set<string> {
  if (!ALLOWLIST_ENV) {
    return new Set(["localhost", "127.0.0.1", "::1"]);
  }
  return new Set(
    ALLOWLIST_ENV
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function assertUrlAllowed(rawUrl: string) {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    createLogger().warn("outbound HTTP blocked", {
      event: "outbound_blocked",
      reason: "invalid_url",
      url: rawUrl,
    });
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  // Require http/https only
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    createLogger().warn("outbound HTTP blocked", {
      event: "outbound_blocked",
      reason: "disallowed_protocol",
      protocol: u.protocol,
      url: rawUrl,
    });
    throw new Error(`Disallowed protocol: ${u.protocol}`);
  }

  const allowlist = buildAllowlist();
  const host = u.hostname;

  if (!allowlist.has(host)) {
    createLogger().warn("outbound HTTP blocked", {
      event: "outbound_blocked",
      reason: "host_not_allowlisted",
      host,
    });
    throw new Error(
      `Destination host not allowlisted: ${host}. Allowlist: ${Array.from(allowlist).join(", ")}`
    );
  }

  // Optional: block non-default ports unless explicitly allowlisted by host alone.
  // (For now we allow any port on allowlisted host.)
}

export async function postJson(url: string, body: unknown) {
  assertUrlAllowed(url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Enforce max payload size (bytes) before sending
      body: (() => {
        const json = JSON.stringify(body);
        const maxBytes = Number(process.env.AGENTGATE_HTTP_MAX_BODY_BYTES || 4096);
        const bytes = Buffer.byteLength(json, "utf8");
        if (bytes > maxBytes) {
          throw new Error(`Request body too large: ${bytes} bytes (max ${maxBytes})`);
        }
        return json;
      })(),
      signal: controller.signal
    });

    // Read response with size limit
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

    let totalBytes = 0;
    const chunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (value) {
        totalBytes += value.length;

        if (totalBytes > DEFAULT_MAX_RESPONSE_BYTES) {
          throw new Error(
            `Response too large: ${totalBytes} bytes (max ${DEFAULT_MAX_RESPONSE_BYTES})`
          );
        }

        chunks.push(value);
      }
    }

    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    const text = new TextDecoder().decode(combined);
    let json: unknown = undefined;

    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // ignore parse errors
    }

    if (!res.ok) {
      throw new Error(`POST ${url} failed: HTTP ${res.status} ${text}`);
    }

    return json;
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`POST ${url} timed out after ${DEFAULT_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}