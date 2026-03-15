import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

const ed25519PublicKeyLength = 32;
const maxSignatureAgeMs = 60_000;
const maxFutureToleranceMs = 5_000;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function toBase64Url(buffer: Buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64(value: string) {
  if (!base64Pattern.test(value)) {
    return null;
  }

  try {
    return Buffer.from(value, "base64");
  } catch {
    return null;
  }
}

function parseTimestampMs(timestamp: string) {
  const numericTimestamp = Number(timestamp);
  if (Number.isFinite(numericTimestamp)) {
    return numericTimestamp;
  }

  const parsedTimestamp = Date.parse(timestamp);
  return Number.isFinite(parsedTimestamp) ? parsedTimestamp : null;
}

function createEd25519PublicKey(publicKeyBase64: string) {
  const publicKeyBytes = decodeBase64(publicKeyBase64);

  if (!publicKeyBytes || publicKeyBytes.length !== ed25519PublicKeyLength) {
    throw new Error("Invalid Ed25519 public key");
  }

  return createPublicKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: toBase64Url(publicKeyBytes)
    },
    format: "jwk"
  });
}

function createEd25519PrivateKey(publicKeyBase64: string, privateKeyBase64: string) {
  const publicKeyBytes = decodeBase64(publicKeyBase64);
  const privateKeyBytes = decodeBase64(privateKeyBase64);

  if (!publicKeyBytes || publicKeyBytes.length !== ed25519PublicKeyLength) {
    throw new Error("Invalid Ed25519 public key");
  }

  if (!privateKeyBytes || privateKeyBytes.length !== ed25519PublicKeyLength) {
    throw new Error("Invalid Ed25519 private key");
  }

  return createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: toBase64Url(publicKeyBytes),
      d: toBase64Url(privateKeyBytes)
    },
    format: "jwk"
  });
}

export function buildSignedMessage(nonce: string, method: string, path: string, timestamp: string, body: unknown) {
  return createHash("sha256").update(`${nonce}${method}${path}${timestamp}${JSON.stringify(body)}`).digest();
}

export function isEd25519PublicKey(publicKeyBase64: string) {
  const publicKeyBytes = decodeBase64(publicKeyBase64);
  return publicKeyBytes?.length === ed25519PublicKeyLength;
}

export function isFreshTimestamp(timestamp: string, now = Date.now()) {
  const timestampMs = parseTimestampMs(timestamp);

  if (timestampMs === null) {
    return false;
  }

  const drift = now - timestampMs;
  return drift <= maxSignatureAgeMs && drift >= -maxFutureToleranceMs;
}

export function verifyRequestSignature(
  publicKeyBase64: string,
  nonce: string,
  method: string,
  path: string,
  timestamp: string,
  body: unknown,
  signatureBase64: string
) {
  const signature = decodeBase64(signatureBase64);

  if (!signature) {
    return false;
  }

  try {
    return verify(null, buildSignedMessage(nonce, method, path, timestamp, body), createEd25519PublicKey(publicKeyBase64), signature);
  } catch {
    return false;
  }
}

export function signRequestSignature(
  publicKeyBase64: string,
  privateKeyBase64: string,
  nonce: string,
  method: string,
  path: string,
  timestamp: string,
  body: unknown
) {
  const signature = sign(
    null,
    buildSignedMessage(nonce, method, path, timestamp, body),
    createEd25519PrivateKey(publicKeyBase64, privateKeyBase64)
  );

  return signature.toString("base64");
}
