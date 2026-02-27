# Intent Bond Protocol Prototype

Minimal local web service for an Intent Bond Protocol (IBP) prototype. It uses Fastify, TypeScript, and SQLite and exposes a small REST API for identities, bond locks, offers, and offer resolution.

## Requirements

- Node.js 20+
- npm 10+

## Run

```bash
npm install
npm run dev
```

The server listens on `http://127.0.0.1:3000` by default and stores data in `data/ibp.sqlite`.

## Scripts

- `npm run dev` starts the service with reload via `tsx`
- `npm run build` compiles TypeScript to `dist/`
- `npm run test` runs the Vitest suite
- `npm run lint` runs a strict TypeScript check

## Example API usage

Create an identity:

```bash
curl -s http://127.0.0.1:3000/v1/identities \
  -H 'content-type: application/json' \
  -d '{"publicKey":"pk_demo"}'
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
    "reason":"serious buyer signal"
  }'
```

Submit an offer:

```bash
curl -s http://127.0.0.1:3000/v1/offers \
  -H 'content-type: application/json' \
  -d '{
    "identityId":"id_...",
    "listingId":"listing-123",
    "priceCents":250000,
    "message":"Ready to close this week",
    "bondId":"bond_..."
  }'
```

Resolve an offer:

```bash
curl -s http://127.0.0.1:3000/v1/offers/offer_.../resolve \
  -H 'content-type: application/json' \
  -d '{"outcome":"accepted"}'
```

Fetch identity reputation:

```bash
curl -s http://127.0.0.1:3000/v1/identities/id_...
```

## Resolution rules

- `accepted` and `rejected` refund 100% of the bond
- `expired` refunds 95% and burns 5%
- `malicious` slashes 100% by default, or a custom `slashBps` if supplied

## Notes

- A bond can back one offer.
- Offer submission requires an active, unexpired bond owned by the same identity.
- Reputation is derived from bond and offer counts with a simple score formula in [src/reputation.ts](/Users/jamestoole/Documents/New project/src/reputation.ts).
