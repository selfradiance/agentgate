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
    "publicKey":"pk_demo"
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
curl -s http://127.0.0.1:3000/v1/actions/execute \
  -H 'content-type: application/json' \
  -d '{
    "identityId":"id_...",
    "bondId":"bond_...",
    "actionType":"listing-interest",
    "payload":{"note":"Ready to proceed"}
  }'
```

Resolve an action as success:

```bash
curl -s http://127.0.0.1:3000/v1/actions/action_.../resolve \
  -H 'content-type: application/json' \
  -d '{
    "outcome":"success"
  }'
```

Resolve an action as malicious:

```bash
curl -s http://127.0.0.1:3000/v1/actions/action_.../resolve \
  -H 'content-type: application/json' \
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
- No real signature verification yet.
- No KYC.
- Local SQLite only.

## Roadmap (short)

- Request signing.
- Pluggable storage.
- Optional on-chain escrow.
