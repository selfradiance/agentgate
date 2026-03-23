// src/agent-adapter.ts

import { generateKeyPairSync, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { signRequestSignature } from "./signing";

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
  identityId: string;
  publicKey: string;
  privateKey: string;
}

interface GeneratedIdentity {
  publicKey: string;
  privateKey: string;
}

interface LockBondResponse {
  bondId?: string;
  bond_id?: string;
  status?: string;
  expiresAt?: string;
  expires_at?: string;
}

interface ExecuteActionResponse {
  action_id?: string;
  actionId?: string;
  status?: string;
  reserved_exposure_cents?: number;
  reservedExposure?: number;
}

interface ResolveActionResponse {
  action_id?: string;
  status?: string;
  bond_id?: string;
  released_exposure_cents?: number;
  slashed_cents_delta?: number;
}

const IDENTITY_FILE = path.resolve(path.dirname(__filename), '../agent-identity.json');

function base64UrlToBase64(value: string) {
  return Buffer.from(value, "base64url").toString("base64");
}

function isAgentIdentity(value: unknown): value is AgentIdentity {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.identityId === "string" &&
    typeof candidate.publicKey === "string" &&
    typeof candidate.privateKey === "string"
  );
}

function hasKeyMaterial(value: unknown): value is GeneratedIdentity {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.publicKey === "string" && typeof candidate.privateKey === "string";
}

async function loadOrCreateIdentity(identityPath: string): Promise<AgentIdentity | GeneratedIdentity> {
  try {
    const existing = await fs.promises.readFile(identityPath, "utf8");
    const parsed: unknown = JSON.parse(existing);

    if (isAgentIdentity(parsed)) {
      return parsed;
    }

    if (hasKeyMaterial(parsed)) {
      throw new Error(
        "agent-identity.json is missing identityId. Delete agent-identity.json and rerun createIdentity()."
      );
    }

    throw new Error("agent-identity.json must contain identityId, publicKey, and privateKey strings");
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

  return {
    publicKey: base64UrlToBase64(publicJwk.x),
    privateKey: base64UrlToBase64(privateJwk.d)
  };
}

async function writeIdentityFile(identityPath: string, identity: AgentIdentity) {
  await fs.promises.mkdir(path.dirname(identityPath), { recursive: true });
  await fs.promises.writeFile(identityPath, `${JSON.stringify(identity, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
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

async function registerIdentity(baseUrl: string, publicKey: string, privateKey: string, agentName?: string, restKey?: string): Promise<string> {
  const url = new URL("/v1/identities", baseUrl);
  const requestBody = { publicKey, ...(agentName ? { agentName } : {}) };
  const path = "/v1/identities";
  const timestamp = Date.now().toString();
  const nonce = randomUUID();
  const signatureBase64 = signRequestSignature(publicKey, privateKey, nonce, "POST", path, timestamp, requestBody);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-agentgate-timestamp": timestamp,
    "x-agentgate-signature": signatureBase64,
    "x-nonce": nonce
  };
  if (restKey) {
    headers["x-agentgate-key"] = restKey;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorBody = await parseErrorBody(response);

    if (isAlreadyExistsError(response.status, errorBody)) {
      throw new Error(
        "Identity already exists on the server. Delete agent-identity.json and rerun createIdentity()."
      );
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

  const responseBody = await response.json() as Record<string, unknown>;
  const identityId =
    typeof responseBody.identityId === "string"
      ? responseBody.identityId
      : typeof responseBody.id === "string"
        ? responseBody.id
        : null;

  if (!identityId) {
    throw new Error(`POST ${url.toString()} succeeded but did not return identityId`);
  }

  return identityId;
}

export class AgentAdapter {
  private identity?: AgentIdentity;
  private identityPath: string;
  private agentName?: string;
  private restKey?: string;

  constructor(private baseUrl: string, identityPath?: string, agentName?: string, restKey?: string) {
    if (agentName && !/^[a-zA-Z0-9_-]+$/.test(agentName)) {
      throw new Error("Invalid agentName: must contain only alphanumeric characters, hyphens, or underscores");
    }
    this.agentName = agentName;
    this.restKey = restKey;
    if (identityPath) {
      this.identityPath = identityPath;
    } else if (agentName) {
      const dir = path.dirname(IDENTITY_FILE);
      this.identityPath = path.join(dir, `agent-identity-${agentName}.json`);
    } else {
      this.identityPath = IDENTITY_FILE;
    }
  }

  async createIdentity(): Promise<{ identityId: string }> {
    const identity = await loadOrCreateIdentity(this.identityPath);

    if ("identityId" in identity) {
      this.identity = identity;
      return { identityId: identity.identityId };
    }

    const identityId = await registerIdentity(this.baseUrl, identity.publicKey, identity.privateKey, this.agentName, this.restKey);
    const storedIdentity: AgentIdentity = { ...identity, identityId };

    await writeIdentityFile(this.identityPath, storedIdentity);
    this.identity = storedIdentity;
    return { identityId };
  }

  private async ensureIdentity(): Promise<void> {
    if (!this.identity) {
      await this.createIdentity();
    }
  }

  private async requireIdentity(): Promise<AgentIdentity> {
    await this.ensureIdentity();
    return this.identity!;
  }

  private async signedPost<T>(path: string, body: unknown): Promise<T> {
    const identity = await this.requireIdentity();

    const timestamp = Date.now().toString();
    const nonce = randomUUID();
    const signatureBase64 = signRequestSignature(
      identity.publicKey,
      identity.privateKey,
      nonce,
      "POST",
      path,
      timestamp,
      body
    );

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-agentgate-timestamp": timestamp,
      "x-agentgate-signature": signatureBase64,
      "x-nonce": nonce
    };
    if (this.restKey) {
      headers["x-agentgate-key"] = this.restKey;
    }

    const response = await fetch(new URL(path, this.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorBody = await parseErrorBody(response);
      const detail =
        typeof errorBody === "string"
          ? errorBody
          : errorBody && typeof errorBody === "object" && "message" in errorBody
            ? String((errorBody as Record<string, unknown>).message)
            : "";

      throw new Error(
        `POST ${response.url} failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`
      );
    }

    return response.json() as Promise<T>;
  }

  async lockBond(
    amountCents: number,
    ttlSeconds: number,
    reason: string
  ): Promise<LockBondResponse> {
    const identity = await this.requireIdentity();
    return this.signedPost("/v1/bonds/lock", {
      identityId: identity.identityId,
      amountCents,
      currency: "USD",
      ttlSeconds,
      reason
    });
  }

  async executeBondedAction(
    bondId: string,
    actionType: string,
    payload: Record<string, unknown>,
    exposureCents: number
  ): Promise<ExecuteActionResponse> {
    const identity = await this.requireIdentity();
    return this.signedPost("/v1/actions/execute", {
      identityId: identity.identityId,
      actionType,
      payload,
      bondId,
      exposure_cents: exposureCents
    });
  }

  async getReputation(identityId: string): Promise<unknown> {
    const url = new URL(`/v1/identities/${identityId}`, this.baseUrl);
    const headers: Record<string, string> = {};
    if (this.restKey) {
      headers["x-agentgate-key"] = this.restKey;
    }
    const response = await fetch(url, { headers });

    if (!response.ok) {
      const errorBody = await parseErrorBody(response);
      const detail =
        typeof errorBody === "string"
          ? errorBody
          : errorBody && typeof errorBody === "object" && "message" in errorBody
            ? String((errorBody as Record<string, unknown>).message)
            : "";

      throw new Error(
        `GET ${url.toString()} failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`
      );
    }

    return response.json();
  }

  async resolveAction(
    actionId: string,
    outcome: "success" | "failed" | "malicious",
    resolverId: string,
    details?: Record<string, unknown>
  ): Promise<ResolveActionResponse> {
    return this.signedPost(`/v1/actions/${actionId}/resolve`, {
      outcome,
      resolverId,
      ...(details ? { details } : {})
    });
  }

  async createMarket(question: string, resolutionDeadline: string) {
    const identity = await this.requireIdentity();
    return this.signedPost("/markets", {
      creatorId: identity.identityId,
      question,
      resolutionDeadline
    });
  }

  async resolveMarket(marketId: string, outcome: "yes" | "no") {
    const identity = await this.requireIdentity();
    return this.signedPost(`/markets/${marketId}/resolve`, {
      outcome,
      resolverId: identity.identityId
    });
  }
}
