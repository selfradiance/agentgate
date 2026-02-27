import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

const baseUrl = "http://127.0.0.1:3000";

function fromBase64Url(value: string) {
  const paddedValue = `${value}${"===".slice((value.length + 3) % 4)}`;
  return Buffer.from(paddedValue.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("base64");
}

function createSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;

  if (!jwk.x) {
    throw new Error("Missing Ed25519 public key");
  }

  return {
    privateKey,
    publicKey: fromBase64Url(jwk.x)
  };
}

function signHeaders(privateKey: KeyObject, body: Record<string, unknown>) {
  const timestamp = Date.now().toString();
  const message = createHash("sha256").update(`${timestamp}${JSON.stringify(body)}`).digest();

  return {
    "x-agentgate-timestamp": timestamp,
    "x-agentgate-signature": sign(null, message, privateKey).toString("base64")
  };
}

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`${response.status} ${JSON.stringify(data)}`);
  }

  return data as Record<string, unknown>;
}

async function main() {
  const signer = createSigner();
  console.log("Creating identity...");
  const identity = await request("/v1/identities", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      publicKey: signer.publicKey
    })
  });
  const identityId = String(identity.identityId);
  console.log("Identity:", identityId);

  console.log("Locking bond...");
  const bond = await request("/v1/bonds/lock", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      identityId,
      amountCents: 2000,
      currency: "USD",
      ttlSeconds: 600,
      reason: "toy agent demo"
    })
  });
  const bondId = String(bond.bondId);
  console.log("Bond:", bondId);

  const executeBody = {
    identityId,
    bondId,
    actionType: "demo-task",
    payload: {
      job: "hello"
    }
  };

  console.log("Executing action...");
  const action = await request("/v1/actions/execute", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...signHeaders(signer.privateKey, executeBody)
    },
    body: JSON.stringify(executeBody)
  });
  const actionId = String(action.actionId);
  console.log("Action:", actionId);

  const resolveBody = {
    outcome: "success"
  };

  console.log("Resolving action...");
  const resolution = await request(`/v1/actions/${actionId}/resolve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...signHeaders(signer.privateKey, resolveBody)
    },
    body: JSON.stringify(resolveBody)
  });
  console.log("Resolution:", resolution);

  console.log("Fetching stats...");
  const stats = await request("/v1/stats");
  console.log("Stats:", stats);
}

main().catch((error) => {
  console.error("Toy agent failed:", error);
  process.exit(1);
});
