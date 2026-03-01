// src/agent-adapter.ts

import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * AgentAdapter
 *
 * This class provides a clean interface for:
 *  - creating an identity
 *  - locking bonds
 *  - executing bonded actions
 *  - resolving actions
 *
 * It hides:
 *  - timestamp generation
 *  - request signing
 *  - raw HTTP endpoint details
 */

interface AgentIdentity {
  publicKey: string;
  privateKey: string;
}

const IDENTITY_FILE = path.resolve(process.cwd(), "agent-identity.json");

function base64UrlToBase64(value: string) {
  return Buffer.from(value, "base64url").toString("base64");
}

function isAgentIdentity(value: unknown): value is AgentIdentity {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.publicKey === "string" && typeof candidate.privateKey === "string";
}

async function loadOrCreateIdentity(): Promise<AgentIdentity> {
  try {
    const existing = await fs.promises.readFile(IDENTITY_FILE, "utf8");
    const parsed: unknown = JSON.parse(existing);

    if (!isAgentIdentity(parsed)) {
      throw new Error("agent-identity.json must contain publicKey and privateKey strings");
    }

    return parsed;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" });
  const privateJwk = privateKey.export({ format: "jwk" });

  if (!publicJwk.x || !privateJwk.d) {
    throw new Error("Failed to export Ed25519 keypair as JWK");
  }

  const identity: AgentIdentity = {
    publicKey: base64UrlToBase64(publicJwk.x),
    privateKey: base64UrlToBase64(privateJwk.d)
  };

  await fs.promises.writeFile(IDENTITY_FILE, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
  return identity;
}

async function parseErrorBody(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }

  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

function isAlreadyExistsError(status: number, body: unknown) {
  if (status === 409) {
    return true;
  }

  if (typeof body === "string") {
    const normalized = body.toLowerCase();
    return normalized.includes("already exists") || normalized.includes("duplicate");
  }

  if (!body || typeof body !== "object") {
    return false;
  }

  const candidate = body as Record<string, unknown>;
  const error = typeof candidate.error === "string" ? candidate.error.toLowerCase() : "";
  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";
  const combined = `${error} ${message}`;

  return combined.includes("already exists") || combined.includes("duplicate");
}

async function registerIdentity(baseUrl: string, publicKey: string) {
  const url = new URL("/v1/identities", baseUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ public_key: publicKey })
  });

  if (response.ok) {
    return;
  }

  const errorBody = await parseErrorBody(response);

  if (isAlreadyExistsError(response.status, errorBody)) {
    return;
  }

  const detail =
    typeof errorBody === "string"
      ? errorBody
      : errorBody && typeof errorBody === "object" && "message" in errorBody
        ? String((errorBody as Record<string, unknown>).message)
        : "";

  throw new Error(
    `POST ${url.toString()} failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`
  );
}

export class AgentAdapter {
  constructor(private baseUrl: string) {}

  async createIdentity(): Promise<void> {
    const identity = await loadOrCreateIdentity();
    await registerIdentity(this.baseUrl, identity.publicKey);
  }

  async lockBond(): Promise<void> {
    throw new Error("Not implemented yet");
  }

  async executeBondedAction(): Promise<void> {
    throw new Error("Not implemented yet");
  }

  async resolveAction(): Promise<void> {
    throw new Error("Not implemented yet");
  }
}
