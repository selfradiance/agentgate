# AgentGate

A collateralized execution gate for AI agents.

## Why AgentGate?

As AI agents reduce the marginal cost of sending bids, API calls, negotiations, and form submissions, systems designed around human friction become vulnerable to synthetic pressure. A single agent can flood a marketplace, spam a booking system, or overwhelm an API — all at near-zero cost.

Traditional defenses don't solve this. Rate limits cap volume but don't make bad actions costly. Auth tokens verify identity but don't require skin in the game. Policy engines enforce rules but can't make an agent economically accountable for its behavior.

AgentGate takes a different approach: **before an agent can execute a high-impact action, it must post a bond as collateral.** If the action succeeds, the bond is released. If the agent behaves maliciously, the bond is slashed. This makes bad behavior economically irrational — the agent loses more than it gains.

AgentGate sits as a deterministic choke point between autonomous agents and external actions (market orders, API calls, financial operations), enforcing economic accountability through signed identities and reusable bond-based exposure tracking.

> **[Threat Model →](docs/threat-model.md)** — What AgentGate defends against, what it doesn't, and why.

---

## Quick Integration

AgentGate works with any agent that can make HTTP requests. The flow is four steps: register an identity, lock a bond, execute an action against that bond, and resolve the outcome.

**1. Register an identity**
```bash
curl -s http://127.0.0.1:3000/v1/identities/register \
  -H 'content-type: application/json' \
  -d '{ "publicKey": "<base64-encoded Ed25519 public key>" }'
```

Returns an `identityId` (e.g., `id_abc123`).

**2. Lock a bond**

All state-changing requests must be signed. Headers required on every request below:

- `x-agentgate-timestamp` — current time in epoch milliseconds
- `x-agentgate-signature` — Ed25519 signature over `sha256(timestamp + JSON.stringify(body))`
```bash
curl -s http://127.0.0.1:3000/v1/bonds/lock \
  -H 'content-type: application/json' \
  -H "x-agentgate-timestamp: $TIMESTAMP" \
  -H "x-agentgate-signature: $SIGNATURE" \
  -d '{ "identityId": "id_abc123", "amount_cents": 5000, "ttl_seconds": 300, "reason": "marketplace bid" }'
```

Returns a `bondId`.

**3. Execute a bonded action**
```bash
curl -s http://127.0.0.1:3000/v1/actions/execute \
  -H 'content-type: application/json' \
  -H "x-agentgate-timestamp: $TIMESTAMP" \
  -H "x-agentgate-signature: $SIGNATURE" \
  -d '{ "identityId": "id_abc123", "bondId": "bond_xyz", "actionType": "place-bid", "payload": { "item": "widget-42", "price": 1500 }, "exposure_cents": 1500 }'
```

Returns an `actionId`. The bond's available capacity is reduced by `ceil(exposure_cents × 1.2)`.

**4. Resolve the action**
```bash
curl -s http://127.0.0.1:3000/v1/actions/<actionId>/resolve \
  -H 'content-type: application/json' \
  -H "x-agentgate-timestamp: $TIMESTAMP" \
  -H "x-agentgate-signature: $SIGNATURE" \
  -d '{ "outcome": "success" }'
```

Outcome must be one of: `success`, `failed`, or `malicious`. On success/failed, exposure is released. On malicious, the bond is slashed.

### Common Errors

| Error | Cause | Fix |
|---|---|---|
| `INVALID_SIGNATURE` | Signature doesn't match body + timestamp | Verify you're signing `sha256(timestamp + JSON.stringify(body))` with the correct private key |
| `TIMESTAMP_EXPIRED` | Timestamp is older than 60 seconds | Use a fresh timestamp for each request |
| `INSUFFICIENT_BOND_CAPACITY` | Bond doesn't have enough remaining capacity | Lock a larger bond or resolve outstanding actions to free capacity |
| `RATE_LIMIT_EXCEEDED` | More than 10 executes in 60 seconds for this identity | Wait and retry, or spread actions across a longer window |

For the full security posture, see the **[Threat Model](docs/threat-model.md)**.

---

## Core Concepts

### Identity

- Ed25519 public key (raw 32-byte base64)
- All state-changing endpoints require signed requests
- Replay protection via timestamp validation
- Replay protection via nonce store

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

- AGENTGATE_HTTP_ALLOWLIST
- AGENTGATE_HTTP_TIMEOUT_MS
- AGENTGATE_HTTP_MAX_BODY_BYTES
- AGENTGATE_HTTP_MAX_RESPONSE_BYTES

---

## MCP Transport

AgentGate exposes its 5 tools to Claude Desktop over two transports:

- **Streamable HTTP** (recommended) — Express server on port 3001 at `/mcp`. Claude Desktop connects via `mcp-remote`. Sessions are managed server-side.
- **stdio** — launches `src/mcp/server.ts` as a subprocess directly from Claude Desktop.

Both transports require the AgentGate HTTP server (`npm run restart`) to be running.

### Claude Desktop config (HTTP transport via mcp-remote)

```json
{
  "mcpServers": {
    "agentgate": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:3001/mcp"]
    }
  }
}
```

File location: `~/Library/Application Support/Claude/claude_desktop_config.json`

---

## Dashboard

AgentGate includes a real-time HTML dashboard at http://127.0.0.1:3000/dashboard (server must be running). It shows a summary bar with identity/bond/action counts, per-identity reputation scores with color coding, and tables for all bonds, actions, and identities with status indicators. The page auto-refreshes every 5 seconds.

---

## Running Locally

Install:

```
npm install
```

Start server:

```
npm run restart
```

This kills any old server process on port 3000 and starts fresh. Server runs at http://127.0.0.1:3000. Dashboard at http://127.0.0.1:3000/dashboard.

To run tests:

```
npm run test
```

---

## Remote Deployment

AgentGate can be deployed to a remote server (tested on DigitalOcean Ubuntu 24.04). Both the Fastify API (port 3000) and MCP HTTP server (port 3001) bind to `0.0.0.0`, making them accessible over the internet.

> **Security status:** UFW firewall is enabled — only ports 22 (SSH), 3000 (API/dashboard), and 3001 (MCP) are open. Auth on the MCP endpoint and TLS are still pending. Do not leave a public instance running unattended until fully hardened.

---

## Demo: MarketGate

Start mock exchange:

node examples/marketgate/mock-exchange.ts

Run toy agent:

npm run example:toy-agent

---

## Project Files

* `src/` — core server logic (Fastify API, service layer, database, signing, logging)
* `src/mcp/` — MCP server exposing 5 tools for Claude Desktop integration
* `src/agent-adapter.ts` — clean agent-facing interface that hides signing and HTTP details
* `src/dashboard.ts` — real-time HTML dashboard
* `test/` — test suite (21 tests)
* `examples/` — demo agents and adapter demo
* `docs/` — threat model and design docs