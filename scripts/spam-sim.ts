import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

const baseUrl = "http://localhost:3000";
const failures: string[] = [];

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
  const signature = sign(null, message, privateKey).toString("base64");

  return {
    "x-agentgate-timestamp": timestamp,
    "x-agentgate-signature": signature
  };
}

async function post(path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }

  return data as Record<string, unknown>;
}

async function main() {
  const signer = createSigner();
  const identity = await post("/v1/identities", {
    publicKey: signer.publicKey
  });

  const identityId = String(identity.identityId);
  let actionsCreated = 0;

  for (let index = 0; index < 20; index += 1) {
    try {
      const bond = await post("/v1/bonds/lock", {
        identityId,
        amountCents: 1000,
        currency: "USD",
        ttlSeconds: 300,
        reason: "spam simulation"
      });

      const actionBody = {
        identityId,
        actionType: "spam-action",
        payload: {
          attempt: index + 1
        },
        bondId: String(bond.bondId)
      };

      await post("/v1/actions/execute", actionBody, signHeaders(signer.privateKey, actionBody));

      actionsCreated += 1;
    } catch (error) {
      failures.push(`action ${index + 1}: ${String(error)}`);
    }
  }

  console.log("Actions created:", actionsCreated);
  console.log("Total capital locked:", 20 * 1000);
  console.log("Failures:", failures);
}

void main();
