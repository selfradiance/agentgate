import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

const baseUrl = "http://127.0.0.1:3000";

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
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(data)}`);
  return data as Record<string, unknown>;
}

async function lockBond(identityId: string, reason: string) {
  const bond = await request("/v1/bonds/lock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      identityId,
      amountCents: 2000,
      currency: "USD",
      ttlSeconds: 600,
      reason
    })
  });
  return String(bond.bondId);
}

async function resolveSuccess(signer: { privateKey: KeyObject }, actionId: string) {
  const body = { outcome: "success" };
  await request(`/v1/actions/${actionId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signHeaders(signer.privateKey, body) },
    body: JSON.stringify(body)
  });
}

async function main() {
  const signer = createSigner();

  console.log("Creating identity...");
  const identity = await request("/v1/identities", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicKey: signer.publicKey })
  });
  const identityId = String(identity.identityId);
  console.log("Identity:", identityId);

  // BOND 1 for placing
  console.log("Locking bond for PLACE...");
  const bondPlace = await lockBond(identityId, "marketgate place demo");
  console.log("BondPlace:", bondPlace);

  const placeBody = {
    identityId,
    bondId: bondPlace,
    actionType: "market.http",
    payload: {
      url: "http://localhost:8787/agent-action",
      body: {
        actionType: "place_order",
        payload: { market: "TEST", side: "yes", price: 0.49, size: 7, note: "via_agentgate" }
      }
    }
  };

  console.log("Placing order via AgentGate...");
  const placeAction = await request("/v1/actions/execute", {
    method: "POST",
    headers: { "content-type": "application/json", ...signHeaders(signer.privateKey, placeBody) },
    body: JSON.stringify(placeBody)
  });
  console.log("Place execute response:", placeAction);

  const placeActionId = String(placeAction.actionId);
  const orderId = (placeAction as any)?.result?.order?.id;
  if (!orderId) throw new Error("Missing orderId from placeAction result");
  console.log("OrderId:", orderId);

  await resolveSuccess(signer, placeActionId);
  console.log("Resolved place action.");

  // BOND 2 for cancelling
  console.log("Locking bond for CANCEL...");
  const bondCancel = await lockBond(identityId, "marketgate cancel demo");
  console.log("BondCancel:", bondCancel);

  const cancelBody = {
    identityId,
    bondId: bondCancel,
    actionType: "market.http",
    payload: {
      url: "http://localhost:8787/agent-action",
      body: {
        actionType: "cancel_order",
        payload: { orderId }
      }
    }
  };

  console.log("Cancelling order via AgentGate...");
  const cancelAction = await request("/v1/actions/execute", {
    method: "POST",
    headers: { "content-type": "application/json", ...signHeaders(signer.privateKey, cancelBody) },
    body: JSON.stringify(cancelBody)
  });
  console.log("Cancel execute response:", cancelAction);

  const cancelActionId = String(cancelAction.actionId);
  await resolveSuccess(signer, cancelActionId);
  console.log("Resolved cancel action.");

  console.log("Done.");
}

main().catch((error) => {
  console.error("Toy agent failed:", error);
  process.exit(1);
});