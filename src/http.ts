// src/http.ts
import { createLogger } from "./logger";

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_MAX_BODY_BYTES = 4096;
const DEFAULT_ALLOWLIST = [
  "localhost:80",
  "localhost:443",
  "127.0.0.1:80",
  "127.0.0.1:443",
  "::1:80",
  "::1:443",
];

function readPositiveIntegerEnv(name: string, fallback: number) {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : fallback;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function buildAllowlist(): Set<string> {
  const allowlistEnv = (process.env.AGENTGATE_HTTP_ALLOWLIST || "").trim();

  if (!allowlistEnv) {
    // Fail closed by default: allow only the standard loopback web ports.
    // Any local dev server on a custom port must be explicitly allowlisted.
    return new Set(DEFAULT_ALLOWLIST);
  }

  return new Set(
    allowlistEnv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

export function assertUrlAllowed(rawUrl: string) {
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

  // new URL("http://[::1]/").hostname === "[::1]" (WHATWG spec includes brackets
  // for IPv6). Allowlist entries are stored without brackets (e.g. "::1"), so
  // strip them before the lookup.
  const rawHost = u.hostname;
  const host = rawHost.startsWith("[") && rawHost.endsWith("]")
    ? rawHost.slice(1, -1)
    : rawHost;

  const port = u.port || defaultPort(u.protocol);
  const hostPort = `${host}:${port}`;
  const hostWildcard = `${host}:*`;

  if (!allowlist.has(hostPort) && !allowlist.has(hostWildcard)) {
    createLogger().warn("outbound HTTP blocked", {
      event: "outbound_blocked",
      reason: "host_port_not_allowlisted",
      hostPort,
    });
    throw new Error(
      `Destination not allowlisted: ${hostPort}. Allowlist: ${Array.from(allowlist).join(", ")}`
    );
  }
}

export async function postJson(url: string, body: unknown): Promise<unknown> {
  return postJsonWithDepth(url, body, 0);
}

async function postJsonWithDepth(url: string, body: unknown, depth: number): Promise<unknown> {
  const timeoutMs = readPositiveIntegerEnv("AGENTGATE_HTTP_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const maxResponseBytes = readPositiveIntegerEnv("AGENTGATE_MAX_RESPONSE_BYTES", DEFAULT_MAX_RESPONSE_BYTES);
  const maxBodyBytes = readPositiveIntegerEnv("AGENTGATE_HTTP_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES);

  if (depth > 5) {
    throw new Error("REDIRECT_BLOCKED: too many redirects");
  }

  assertUrlAllowed(url);

  // Serialize and size-check the request body before opening a connection
  const serialized = JSON.stringify(body === undefined ? null : body);
  const bodyBytes = Buffer.byteLength(serialized, "utf8");
  if (bodyBytes > maxBodyBytes) {
    throw new Error(`Request body too large: ${bodyBytes} bytes (max ${maxBodyBytes})`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

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
      if (location.startsWith("//")) {
        throw new Error("REDIRECT_BLOCKED: protocol-relative redirect is not allowed");
      }
      const nextUrl = new URL(location, url).toString();
      try {
        assertUrlAllowed(nextUrl);
      } catch (err: any) {
        throw new Error(`REDIRECT_BLOCKED: ${err.message}`);
      }
      return postJsonWithDepth(nextUrl, body, depth + 1);
    }

    // Read response with size limit
    const reader = res.body?.getReader();
    if (!reader) {
      if (!res.ok) {
        throw new Error(`POST ${url} failed: HTTP ${res.status}`);
      }
      return "";
    }

    let totalBytes = 0;
    const chunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (value) {
        totalBytes += value.length;

        if (totalBytes > maxResponseBytes) {
          await reader.cancel();
          createLogger().warn("outbound response too large", {
            event: "response_too_large",
            url,
            totalBytes,
            maxBytes: maxResponseBytes,
          });
          throw new Error(
            `RESPONSE_TOO_LARGE: ${totalBytes} bytes received (max ${maxResponseBytes})`
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
    let json: unknown;

    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // ignore parse errors
    }

    if (!res.ok) {
      throw new Error(`POST ${url} failed: HTTP ${res.status} ${text}`);
    }

    return json ?? "";
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`POST ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
