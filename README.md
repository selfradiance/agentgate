# AgentGate

AgentGate is a small backend microservice for stake-gated actions: an identity locks a bond, executes an action against that bond, and later resolves the action to refund, burn, or slash the locked capital according to the outcome.

## Quickstart

Install dependencies:

```bash
npm install
```

Run the development server:

```bash
npm run dev
```

Run the test suite:

```bash
npm run test
```

The server listens on `http://127.0.0.1:3000` by default and uses local SQLite storage at `data/ibp.sqlite`.

## Request Signing

`POST /v1/actions/execute` and `POST /v1/actions/:id/resolve` require:

- `x-agentgate-timestamp`
- `x-agentgate-signature`

The identity public key must be a base64-encoded Ed25519 public key. The signature is base64-encoded Ed25519 over:

```text
SHA256(timestamp + JSON.stringify(body))
```

Timestamps older than 60 seconds are rejected.

## API Summary

- `POST /v1/identities`
- `POST /v1/bonds/lock`
- `POST /v1/actions/execute`
- `POST /v1/actions/:id/resolve`
- `GET /v1/stats`

## cURL Examples

Create an identity:

```bash
curl -s http://127.0.0.1:3000/v1/identities \
  -H 'content-type: application/json' \
  -d '{
    "publicKey":"BASE64_ED25519_PUBLIC_KEY"
  }'
```

Lock a bond:

```bash
curl -s http://127.0.0.1:3000/v1/bonds/lock \
  -H 'content-type: application/json' \
  -d '{
    "identityId":"id_...",
    "amountCents":1500,
    "currency":"USD",
    "ttlSeconds":600,
    "reason":"serious intent signal"
  }'
```

Execute an action:

```bash
TIMESTAMP="$(date +%s000)"

curl -s http://127.0.0.1:3000/v1/actions/execute \
  -H 'content-type: application/json' \
  -H "x-agentgate-timestamp: $TIMESTAMP" \
  -H 'x-agentgate-signature: BASE64_SIGNATURE' \
  -d '{
    "identityId":"id_...",
    "bondId":"bond_...",
    "actionType":"listing-interest",
    "payload":{"note":"Ready to proceed"}
  }'
```

Resolve an action as success:

```bash
TIMESTAMP="$(date +%s000)"

curl -s http://127.0.0.1:3000/v1/actions/action_.../resolve \
  -H 'content-type: application/json' \
  -H "x-agentgate-timestamp: $TIMESTAMP" \
  -H 'x-agentgate-signature: BASE64_SIGNATURE' \
  -d '{
    "outcome":"success"
  }'
```

Resolve an action as malicious:

```bash
TIMESTAMP="$(date +%s000)"

curl -s http://127.0.0.1:3000/v1/actions/action_.../resolve \
  -H 'content-type: application/json' \
  -H "x-agentgate-timestamp: $TIMESTAMP" \
  -H 'x-agentgate-signature: BASE64_SIGNATURE' \
  -d '{
    "outcome":"malicious"
  }'
```

Fetch aggregate stats:

```bash
curl -s http://127.0.0.1:3000/v1/stats
```

## Non-goals / Limitations

- Not production-ready escrow.
- No nonce store or durable replay tracking beyond the 60-second timestamp window.
- No KYC.
- Local SQLite only.

## Roadmap (short)

- Replay protection hardening.
- Pluggable storage.
- Optional on-chain escrow.
