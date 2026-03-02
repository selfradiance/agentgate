# AgentGate

A collateralized execution gate for AI agents.

## Why AgentGate?

As AI agents reduce the marginal cost of sending bids, API calls, negotiations, and form submissions, systems designed around human friction become vulnerable to synthetic pressure. A single agent can flood a marketplace, spam a booking system, or overwhelm an API — all at near-zero cost.

Traditional defenses don't solve this. Rate limits cap volume but don't make bad actions costly. Auth tokens verify identity but don't require skin in the game. Policy engines enforce rules but can't make an agent economically accountable for its behavior.

AgentGate takes a different approach: **before an agent can execute a high-impact action, it must post a bond as collateral.** If the action succeeds, the bond is released. If the agent behaves maliciously, the bond is slashed. This makes bad behavior economically irrational — the agent loses more than it gains.

AgentGate sits as a deterministic choke point between autonomous agents and external actions (market orders, API calls, financial operations), enforcing economic accountability through signed identities and reusable bond-based exposure tracking.

> **[Threat Model →](docs/threat-model.md)** — What AgentGate defends against, what it doesn't, and why.

---

## Development Workflow Rule

After any major architectural milestone (new layer added, schema change, security rail, MCP change, adapter change):

1. Run full typecheck and demo verification
2. Commit with a clear milestone message
3. Push to GitHub
4. Update this README with:
   - What changed
   - Current system architecture state
   - Next planned step

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

* src/ — core server logic
* test/ — test suite (16 tests)
* examples/ — demo agents and mock exchange
* docs/ — threat model and design docs