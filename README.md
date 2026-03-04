# AgentGate

A collateralized execution gate for AI agents.

## Why AgentGate?

As AI agents reduce the marginal cost of sending bids, API calls, negotiations, and form submissions, systems designed around human friction become vulnerable to synthetic pressure. A single agent can flood a marketplace, spam a booking system, or overwhelm an API — all at near-zero cost.

Traditional defenses don't solve this. Rate limits cap volume but don't make bad actions costly. Auth tokens verify identity but don't require skin in the game. Policy engines enforce rules but can't make an agent economically accountable for its behavior.

AgentGate takes a different approach: **before an agent can execute a high-impact action, it must post a bond as collateral.** If the action succeeds, the bond is released. If the agent behaves maliciously, the bond is slashed. This makes bad behavior economically irrational — the agent loses more than it gains.

AgentGate sits as a deterministic choke point between autonomous agents and external actions (market orders, API calls, financial operations), enforcing economic accountability through signed identities and reusable bond-based exposure tracking.

> **[Threat Model →](docs/threat-model.md)** — What AgentGate defends against, what it doesn't, and why.

Read the full story: [How I Built AgentGate](docs/manifesto.md)

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
- **Redirect protection** — `fetch` is called with `redirect: "manual"`; every redirect hop has its `Location` header re-checked against the allowlist before following (max 5 hops). Prevents an allowlisted host from acting as a trampoline to a non-allowlisted host.
- Errors wrapped as DESTINATION_BLOCKED or REDIRECT_BLOCKED

Environment variables:

- AGENTGATE_HTTP_ALLOWLIST
- AGENTGATE_HTTP_TIMEOUT_MS
- AGENTGATE_HTTP_MAX_BODY_BYTES
- AGENTGATE_MAX_RESPONSE_BYTES

---

## MCP Transport

AgentGate exposes its 7 tools to Claude Desktop over two transports:

- **Streamable HTTP** (recommended) — Express server on port 3001 at `/mcp`. Claude Desktop connects via `mcp-remote`. Sessions are managed server-side.
- **stdio** — launches `src/mcp/server.ts` as a subprocess directly from Claude Desktop.

Both transports require the AgentGate HTTP server (`npm run restart`) to be running.

### Claude Desktop config (HTTP transport via mcp-remote)

**Local:**
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

**Remote (agentgate.run):**
```json
{
  "mcpServers": {
    "agentgate": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.agentgate.run/mcp"]
    }
  }
}
```

File location: `~/Library/Application Support/Claude/claude_desktop_config.json`

### MCP Tools (7 total)

| Tool | Description |
|---|---|
| `create_identity` | Create or load an Ed25519 agent identity |
| `lock_bond` | Lock a bond (stake) for an identity |
| `execute_bonded_action` | Execute a bonded action through the gate |
| `resolve_action` | Resolve an action as success/failed/malicious |
| `get_reputation` | Get identity reputation score |
| `create_market` | Create a prediction market with a yes/no question and resolution deadline |
| `resolve_market` | Resolve an open market as yes/no — settles all positions automatically |

---

## Prediction Markets

AgentGate includes a prediction market demo that illustrates multi-agent economic coordination using bonds as stake.

**How it works:**

1. An operator creates a market with a yes/no question and a resolution deadline
2. Agents take positions by executing a `market.position` action against a locked bond, declaring a `side` of `yes` or `no`
3. When the market resolves, all open positions are settled automatically — winners' bonds are released, losers' bonds are burned

**REST endpoints:**

```bash
# Create a market
curl -s http://127.0.0.1:3000/markets \
  -H 'content-type: application/json' \
  -H 'x-agentgate-key: YOUR_KEY' \
  -d '{ "question": "Will BTC hit 100k by Friday?", "resolutionDeadline": "2025-01-10T00:00:00Z" }'

# Resolve a market
curl -s http://127.0.0.1:3000/markets/<marketId>/resolve \
  -H 'content-type: application/json' \
  -H 'x-agentgate-key: YOUR_KEY' \
  -d '{ "outcome": "yes" }'
```

**MCP tools:** `create_market` and `resolve_market` expose the same flow to Claude Desktop.

The dashboard shows a live Markets table with status color-coding (open → amber, resolved → green).

---

## Health Check

```
GET /health
```

Returns `200 OK` with `{ "status": "ok", "timestamp": "<ISO>" }`. No authentication required — designed for external uptime monitors (e.g. UptimeRobot). Monitored at https://agentgate.run/health every 5 minutes.

---

## Dashboard

AgentGate includes a real-time HTML dashboard at http://127.0.0.1:3000/dashboard (local) or https://agentgate.run/dashboard (remote). Server must be running. It shows a summary bar with identity/bond/action counts, per-identity reputation scores with color coding, and tables for all bonds, actions, and identities with status indicators. The page auto-refreshes every 5 seconds.

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

## Security

### MCP Endpoint Authentication

The MCP HTTP endpoint (port 3001) is protected by a shared-secret header.

- Set `AGENTGATE_MCP_KEY` in your `.env` file (loaded automatically via dotenv on startup)
- If the key is **not set**, a warning is logged at startup and all requests are allowed through (suitable for local dev)
- If the key **is set**, any request to `/mcp` without a matching `x-agentgate-key` header receives a `401 UNAUTHORIZED` response

Example request with the key:

```bash
curl -H "x-agentgate-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '...' \
  http://HOST:3001/mcp
```

`.env` entry:

```
AGENTGATE_MCP_KEY=your-long-random-secret
```

### REST API & Dashboard Authentication

The REST API (all POST routes on port 3000) and dashboard are protected by `AGENTGATE_REST_KEY`.

- Set `AGENTGATE_REST_KEY` in your `.env` file
- If not set, a warning is logged at startup and all requests are allowed through (local dev)
- **POST routes:** require an `x-agentgate-key` header matching the key; returns `401 UNAUTHORIZED` if missing or wrong
- **Dashboard (`/dashboard`):** protected by HTTP Basic Auth — username `admin`, password is the key value; the browser will show a login popup automatically

```
AGENTGATE_REST_KEY=your-long-random-secret
```

### Identity Governance

Operators can ban and unban identities via the admin API. Banned identities receive `403 IDENTITY_BANNED` on all `lockBond` and `executeAction` calls.

```bash
# Ban an identity
curl -s http://127.0.0.1:3000/admin/ban-identity \
  -H 'content-type: application/json' \
  -H 'x-agentgate-key: YOUR_KEY' \
  -d '{ "publicKey": "<base64-encoded Ed25519 public key>" }'

# Unban an identity
curl -s http://127.0.0.1:3000/admin/unban-identity \
  -H 'content-type: application/json' \
  -H 'x-agentgate-key: YOUR_KEY' \
  -d '{ "publicKey": "<base64-encoded Ed25519 public key>" }'
```

**Auto-ban:** an identity is automatically banned after 3 malicious action resolutions. The trigger logs an `identity_auto_banned` security event.

### Security Event Logging

All security-relevant events are logged as structured JSON to stderr with an `event` field for easy filtering:

| `event` | Trigger |
|---|---|
| `auth_failed` | Wrong or missing `x-agentgate-key` on REST or MCP |
| `signature_failed` | Missing headers, stale timestamp, or bad Ed25519 signature |
| `duplicate_nonce` | Same nonce reused by the same identity |
| `bond_slashed` | Action resolved as malicious (via API or sweeper) |
| `identity_auto_banned` | Identity automatically banned after 3 malicious resolutions |
| `outbound_blocked` | `market.http` action blocked by allowlist or protocol check |

Each entry includes relevant context: `identityId` (truncated), `endpoint`, `reason`, and `requestId` where available.

---

## Security Hardening

AgentGate v0.2.0 was put through a structured red team process before release: 20 adversarial attack scenarios written as automated tests across 5 phases.

**Invariant validator** — every attack test ends by calling `validateInvariants(db)`, which runs 8 SQL assertions against the live database: bond amounts never go negative, outstanding exposure never exceeds bond capacity, settlement is always consistent, and nonces are never duplicated. Any state corruption — however subtle — causes an immediate test failure with a precise diagnostic.

**Attack phases:**

| Phase | Focus | Tests | Findings |
|---|---|---|---|
| 1 | Bond/exposure math | 6 | Fixed: `slashed_cents` not written to DB on malicious resolution; negative `exposure_cents` bypassed service-layer guard |
| 2 | Sweeper edge cases | 3 | Confirmed: resolve/sweep race is safe (SQLite serialization); double-slash prevented by open-action query |
| 3 | Replay attacks | 4 | Confirmed: nonce check catches replays even within the 60-second timestamp window; parallel duplicate nonce via `Promise.all` safely rejected |
| 4 | SQLite concurrency | 2 | Confirmed: `better-sqlite3` synchronous transactions serialize concurrent requests correctly |
| 5 | Outbound HTTP | 9 | Fixed: redirect bypass SSRF (allowlisted host could 302 to non-allowlisted target); IPv6 bracket allowlist bug (`[::1]` vs `::1`) |

**Total: 3 logic bugs fixed, 1 SSRF vulnerability fixed, 48 tests passing.**

Full attack scenarios documented in [`docs/red-team-plan.md`](docs/red-team-plan.md).

---

## Remote Deployment

AgentGate is deployed to a DigitalOcean droplet (Ubuntu 24.04) at [agentgate.run](https://agentgate.run).

> **Security status:** UFW firewall enabled (ports 22, 80, 443 only — ports 3000 and 3001 are no longer publicly accessible). TLS live via Caddy reverse proxy with auto-managed Let's Encrypt certificates. Auth in place on both services (`x-agentgate-key` on MCP, `x-agentgate-key` + Basic Auth on REST/dashboard).

- **Dashboard:** https://agentgate.run/dashboard
- **MCP endpoint:** https://mcp.agentgate.run/mcp
- **Caddy config:** `/etc/caddy/Caddyfile` on the server — proxies agentgate.run → 127.0.0.1:3000 and mcp.agentgate.run → 127.0.0.1:3001

SSH access uses an Ed25519 key — no password required for deploys (`ssh root@174.138.63.42`).

The server is managed by **pm2**, which keeps it running after you disconnect from SSH and restarts it automatically on crash or reboot.

```bash
pm2 status               # check if agentgate is running
pm2 logs agentgate       # tail live logs
pm2 restart agentgate    # apply updates
pm2 stop agentgate       # stop the server
```

---

## Demo: MarketGate

Start mock exchange:

node examples/marketgate/mock-exchange.ts

Run toy agent:

npm run example:toy-agent

---

## Project Files

* `src/` — core server logic (Fastify API, service layer, database, signing, logging)
* `src/mcp/` — MCP server exposing 7 tools for Claude Desktop integration
* `src/agent-adapter.ts` — clean agent-facing interface that hides signing and HTTP details
* `src/dashboard.ts` — real-time HTML dashboard
* `test/` — test suite (56 tests, including red team adversarial suite and prediction market tests)
* `examples/` — demo agents and adapter demo
* `docs/` — threat model and design docs