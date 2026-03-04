// src/http.ts
import { createLogger } from "./logger";
const DEFAULT_TIMEOUT_MS = Number(process.env.AGENTGATE_HTTP_TIMEOUT_MS || 2500);
const MAX_RESPONSE_BYTES = Number(process.env.AGENTGATE_MAX_RESPONSE_BYTES || 1_048_576);
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

export async function postJson(url: string, body: unknown): Promise<unknown> {
  return postJsonWithDepth(url, body, 0);
}

async function postJsonWithDepth(url: string, body: unknown, depth: number): Promise<unknown> {
  if (depth > 5) {
    throw new Error("REDIRECT_BLOCKED: too many redirects");
  }

  assertUrlAllowed(url);

  // Serialize and size-check the request body before opening a connection
  const serialized = JSON.stringify(body);
  const maxBodyBytes = Number(process.env.AGENTGATE_HTTP_MAX_BODY_BYTES || 4096);
  const bodyBytes = Buffer.byteLength(serialized, "utf8");
  if (bodyBytes > maxBodyBytes) {
    throw new Error(`Request body too large: ${bodyBytes} bytes (max ${maxBodyBytes})`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: serialized,
      signal: controller.signal,
      redirect: "manual",
    });

    // Handle redirects manually so every hop is re-validated against the allowlist.
    // Without this check, an allowlisted host could 302 to an internal service,
    // bypassing the allowlist entirely.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new Error("REDIRECT_BLOCKED: redirect response has no Location header");
      }
      try {
        assertUrlAllowed(location);
      } catch (err: any) {
        throw new Error(`REDIRECT_BLOCKED: ${err.message}`);
      }
      return postJsonWithDepth(location, body, depth + 1);
    }

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

        if (totalBytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          createLogger().warn("outbound response too large", {
            event: "response_too_large",
            url,
            totalBytes,
            maxBytes: MAX_RESPONSE_BYTES,
          });
          throw new Error(
            `RESPONSE_TOO_LARGE: ${totalBytes} bytes received (max ${MAX_RESPONSE_BYTES})`
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