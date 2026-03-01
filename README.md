# AgentGate (Intent Bond Protocol)

AgentGate is a collateralized execution engine for AI agents.

It enforces economic accountability through signed identities and reusable bond-based exposure tracking.

AgentGate is designed to act as a deterministic choke point between autonomous agents and high-impact external actions (e.g., market orders, API calls, financial operations).

---

## Core Concepts

### Identity

- Ed25519 public key (raw 32-byte base64)
- All state-changing endpoints require signed requests
- Replay protection via timestamp validation

Signed message format:

sha256(timestamp + JSON.stringify(body))

Required headers:

x-agentgate-timestamp
x-agentgate-signature

---

### Reusable Bond Model

Bonds are not single-use.

Each bond represents reusable execution capacity.

Bond fields:

- amount_cents
- outstanding_exposure_cents
- slashed_cents
- ttl_seconds
- status

Capacity rule:

Effective exposure = ceil(declared_exposure × multiplier)

Default multiplier: 1.2

Constraint:

outstanding_exposure_cents + effective_exposure <= amount_cents

If exceeded → INSUFFICIENT_BOND_CAPACITY

---

### Exposure Lifecycle

On execute:
- Exposure reserved
- outstanding_exposure_cents incremented

On resolve:
- Exposure released
- Bond remains active

On malicious:
- amount_cents reduced (clamped at zero)
- slashed_cents increased

---

### Action Model

Actions include:

- action_type
- payload
- exposure_cents
- status (open / success / failed / malicious)

Multiple actions per bond are supported.

---

### Outbound HTTP Safety (`market.http`)

- Allowlist enforcement (default: localhost only)
- http/https only
- Timeout (default 2500ms)
- Max request size
- Max response size
- Errors wrapped as DESTINATION_BLOCKED

Environment variables:

- IBP_HTTP_ALLOWLIST
- IBP_HTTP_TIMEOUT_MS
- IBP_HTTP_MAX_BODY_BYTES
- IBP_HTTP_MAX_RESPONSE_BYTES

---

## Running Locally

Install:

npm install

Start server:

npm run dev

Default address: 127.0.0.1:3000

---

## Demo: MarketGate

Start mock exchange:

node examples/marketgate/mock-exchange.ts

Run toy agent:

npm run example:toy-agent

---

## Project Files

- src/ — core server logic
- examples/ — demo agents and mock exchange
- PROJECT_CONTEXT.md — authoritative architecture snapshot
- marketgate_build_log.md — chronological build history