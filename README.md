# AgentGate

A collateralized execution engine for AI agents.

[![CI](https://github.com/selfradiance/agentgate/actions/workflows/ci.yml/badge.svg)](https://github.com/selfradiance/agentgate/actions/workflows/ci.yml)

## Why AgentGate?

As AI agents reduce the marginal cost of sending bids, API calls, negotiations, and form submissions, systems designed around human friction become vulnerable to synthetic pressure. A single agent can flood a marketplace, spam a booking system, or overwhelm an API — all at near-zero cost.

Traditional defenses don't solve this. Rate limits cap volume but don't make bad actions costly. Auth tokens verify identity but don't require skin in the game. Policy engines enforce rules but can't make an agent economically accountable for its behavior.

AgentGate takes a different approach: **before an agent can execute a high-impact action, it must post a bond as collateral.** If the action succeeds, the bond is released. If the agent behaves maliciously, the bond is slashed. This makes bad behavior economically irrational — the agent loses more than it gains.

AgentGate sits as a deterministic choke point between autonomous agents and external actions (market orders, API calls, financial operations), enforcing economic accountability through signed identities and reusable bond-based exposure tracking.

> **[Threat Model →](docs/threat-model.md)** — What AgentGate defends against, what it doesn't, and why.

Read the full story: **[How I Built AgentGate](docs/manifesto.md)**

---

## Quick Integration

AgentGate works with any agent that can make HTTP requests. The flow is four steps: register an identity, lock a bond, execute an action against that bond, and resolve the outcome.

> **Note:** The curl examples below assume `AGENTGATE_DEV_MODE=true` for local development (auth key enforcement is skipped). In production, add `-H 'x-agentgate-key: YOUR_KEY'` to every POST request.

**1. Register an identity**

Identity registration requires proof-of-possession — the caller must sign the request with the private key matching the public key being registered. This uses the same signature headers as all other state-changing endpoints:

```bash
curl -s http://127.0.0.1:3000/v1/identities \
  -H 'content-type: application/json' \
  -H "x-agentgate-timestamp: $TIMESTAMP" \
  -H "x-agentgate-signature: $SIGNATURE" \
  -H "x-nonce: $(uuidgen)" \
  -d '{ "publicKey": "<base64-encoded Ed25519 public key>" }'
```

Returns an `identityId` (e.g., `id_abc123`).

**2. Lock a bond**

All state-changing requests must be signed. Headers required on every request:

- `x-agentgate-timestamp` — current time in epoch milliseconds
- `x-agentgate-signature` — Ed25519 signature over `sha256(nonce + method + path + timestamp + JSON.stringify(body))`
- `x-nonce` — a unique string per request (UUID recommended); bound into the signed message AND stored server-side — the server rejects duplicates per identity, providing replay protection on top of the timestamp window

```bash
curl -s http://127.0.0.1:3000/v1/bonds/lock \
  -H 'content-type: application/json' \
  -H "x-agentgate-timestamp: $TIMESTAMP" \
  -H "x-agentgate-signature: $SIGNATURE" \
  -H "x-nonce: $(uuidgen)" \
  -d '{ "identityId": "id_abc123", "amount_cents": 5000, "ttl_seconds": 300, "reason": "marketplace bid" }'
```

Returns a `bondId`.

**3. Execute a bonded action**
```bash
curl -s http://127.0.0.1:3000/v1/actions/execute \
  -H 'content-type: application/json' \
  -H "x-agentgate-timestamp: $TIMESTAMP" \
  -H "x-agentgate-signature: $SIGNATURE" \
  -H "x-nonce: $(uuidgen)" \
  -d '{ "identityId": "id_abc123", "bondId": "bond_xyz", "actionType": "place-bid", "payload": { "item": "widget-42", "price": 1500 }, "exposure_cents": 1500 }'
```

Returns an `actionId`. The bond's available capacity is reduced by `ceil(exposure_cents × 1.2)`.

**4. Resolve the action**
```bash
curl -s http://127.0.0.1:3000/v1/actions/<actionId>/resolve \
  -H 'content-type: application/json' \
  -H "x-agentgate-timestamp: $TIMESTAMP" \
  -H "x-agentgate-signature: $SIGNATURE" \
  -H "x-nonce: $(uuidgen)" \
  -d '{ "outcome": "success" }'
```

Outcome must be one of: `success`, `failed`, or `malicious`. On success/failed, exposure is released. On malicious, the bond is slashed.

### Common Errors

| Error | Cause | Fix |
|---|---|---|
| `INVALID_SIGNATURE` | Signature doesn't match body + timestamp | Verify you're signing `sha256(nonce + method + path + timestamp + JSON.stringify(body))` with the correct private key |
| `TIMESTAMP_EXPIRED` | Timestamp is older than 60 seconds | Use a fresh timestamp for each request |
| `DUPLICATE_NONCE` | Same nonce reused by the same identity | Generate a fresh UUID for every request |
| `INSUFFICIENT_BOND_CAPACITY` | Bond doesn't have enough remaining capacity | Lock a larger bond or resolve outstanding actions to free capacity |
| `RATE_LIMIT_EXCEEDED` | More than 10 executes in 60 seconds for this identity | Wait and retry, or spread actions across a longer window |
| `IDENTITY_BANNED` | Identity has been banned (manually or after 3 malicious resolutions) | Contact the operator or use a different identity |
| `SERVER_MISCONFIGURED` | Auth key not set and `AGENTGATE_DEV_MODE` is not `true` | Set the missing auth key or set `AGENTGATE_DEV_MODE=true` for local dev |

For the full security posture, see the **[Threat Model](docs/threat-model.md)**.

---

## Core Concepts

### Identity

- Ed25519 public key (raw 32-byte base64)
- All state-changing endpoints require signed requests — including identity registration itself, which requires proof-of-possession (the caller must sign the request with the private key matching the public key being registered)
- Public key uniqueness enforced at the database level — duplicate identity registration is rejected with `409 DUPLICATE_IDENTITY`
- Replay protection via timestamp validation (60-second window, 5-second future tolerance) AND nonce store (duplicate rejection per identity)
- Named agent support: set `AGENTGATE_AGENT_NAME` env var to create separate identity files per agent (e.g., `agent-identity-trader.json`)

Signed message format: `sha256(nonce + method + path + timestamp + JSON.stringify(body))`

Required headers: `x-agentgate-timestamp`, `x-agentgate-signature`, `x-nonce`

### Reusable Bond Model

Bonds are not single-use. Each bond represents reusable execution capacity.

- **Capacity rule:** effective exposure = `ceil(declared_exposure × 1.2)`
- **Constraint:** `outstanding_exposure_cents + effective_exposure <= amount_cents`
- If exceeded → `INSUFFICIENT_BOND_CAPACITY`
- **TTL cap:** maximum 86400 seconds (24 hours) — requests exceeding the cap are rejected
- Bond status lifecycle: `active` → `occupied` (when action attached) → `released` / `burned` / `slashed`

### Exposure Lifecycle

Bonds support multiple concurrent actions. Each action reserves its own slice of the bond's capacity, and resolving one action only releases that action's exposure — other open actions on the same bond are unaffected.

- **Execute:** exposure reserved, `outstanding_exposure_cents` incremented, bond marked `occupied`
- **Resolve (success/failed):** that action's exposure released; `refund_cents` accumulated on the bond; bond returns to `active` only when all open actions are resolved
- **Resolve (malicious):** `amount_cents` reduced (clamped at zero), `slashed_cents` and `burned_cents` increased; bond `burned` only when no open actions remain
- **Settlement accounting:** `refund_cents`, `burned_cents`, `slashed_cents`, and `closed_at` (ISO timestamp) are persisted on the bond record at resolution time

### Auto-Slash Sweeper

A background sweeper runs every 60 seconds, checking for actions whose associated bond has expired while the action is still open. Any such action is automatically resolved as `malicious` — the bond is slashed using the same settlement logic as a manual malicious resolution. On the same 60-second interval, the server also cleans up expired nonces (older than 5 minutes) and expired rate-limit buckets (older than 60 seconds). All three run with clean shutdown on SIGINT/SIGTERM.

### Reputation Scoring

Each identity accumulates a reputation score based on its history:

`score = locks×2 + actions×3 + successes×10 - failures×5 - malicious×20`

The dashboard shows per-identity scores with color coding (green for positive, red for negative, gray for zero). Available via the `get_reputation` MCP tool or the dashboard.

### Outbound HTTP Safety (`market.http`)

- **Host:port allowlist** — each allowlist entry is a `host:port` pair (e.g., `localhost:3000`). Wildcard port supported (e.g., `localhost:*`). Default allowlist uses wildcards for local dev; production deployments should set `AGENTGATE_HTTP_ALLOWLIST` with explicit host:port pairs
- http/https only (default port inferred: 80 for http, 443 for https)
- Timeout (default 2500ms)
- Max request size, max response size
- **Response sanitization** — before persisting outbound response data to the database, headers are stripped and the body is truncated to 1024 characters (with a `[truncated]` marker). This only affects storage — the full response is still returned to the caller
- **Redirect protection** — `fetch` is called with `redirect: "manual"`; every redirect hop has its `Location` header re-checked against the allowlist before following (max 5 hops). Prevents an allowlisted host from acting as a trampoline to a non-allowlisted host.
- Errors wrapped as `DESTINATION_BLOCKED` or `REDIRECT_BLOCKED`

Environment variables: `AGENTGATE_HTTP_ALLOWLIST`, `AGENTGATE_HTTP_TIMEOUT_MS`, `AGENTGATE_HTTP_MAX_BODY_BYTES`, `AGENTGATE_MAX_RESPONSE_BYTES`

---

## MCP Transport

AgentGate exposes its 7 tools to Claude Desktop over two transports:

- **Streamable HTTP** (recommended) — Express server on port 3001 at `/mcp`. Claude Desktop connects via `mcp-remote`. Sessions are managed server-side with a 100-session cap, 1MB body size limit, and automatic cleanup of sessions idle for more than 5 minutes.
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

1. An operator creates a market with a yes/no question and a resolution deadline (must be a valid future ISO 8601 timestamp)
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

## Dashboard

AgentGate includes a real-time HTML dashboard at http://127.0.0.1:3000/dashboard (local) or https://agentgate.run/dashboard (remote). It shows:

- Summary bar with identity, bond, action, and market counts
- Per-identity reputation scores with color coding
- Tables for bonds, actions, identities, and markets with truncated IDs and status indicators
- Agent names displayed per identity (for multi-agent setups)
- `[BANNED]` tags on banned identities

The page auto-refreshes every 5 seconds. The server must be running.

---

## Health Check

```
GET /health
```

Returns `200 OK` with `{ "status": "ok", "timestamp": "<ISO>" }`. No authentication required — designed for external uptime monitors (e.g., UptimeRobot). Monitored at https://agentgate.run/health every 5 minutes.

---

## Running Locally

**Install:**

```
npm install
```

**Start server:**

```
npm run restart
```

This kills any old server process on port 3000 and starts fresh. Fastify REST API runs at http://127.0.0.1:3000, MCP HTTP server at http://127.0.0.1:3001/mcp, dashboard at http://127.0.0.1:3000/dashboard. The sweeper, nonce cleanup, and bucket cleanup logs appear every 60 seconds. Database file is created automatically at `data/agentgate.sqlite` on first run, with automatic backups to `data/backups/` on each startup (keeps the 5 most recent).

**Run tests:**

```
npm run test
```

70 tests across 6 test suites (API, MCP integration, prediction markets, sweeper, red team, outbound HTTP).

---

## Security

### Nonce Replay Protection

All POST endpoints require an `x-nonce` header. The server stores each nonce per identity and rejects duplicates with a `409 DUPLICATE_NONCE` response. The `AgentAdapter` generates UUID nonces automatically. Expired nonces (older than 5 minutes) are cleaned up every 60 seconds alongside the sweeper. This provides replay protection on top of the 60-second timestamp window.

### MCP Endpoint Authentication

The MCP HTTP endpoint (port 3001) is protected by a shared-secret header.

- Set `AGENTGATE_MCP_KEY` in your `.env` file (loaded automatically via dotenv on startup)
- If the key is **not set** and `AGENTGATE_DEV_MODE` is not `true`, requests are rejected with `500 SERVER_MISCONFIGURED`
- If the key is **not set** and `AGENTGATE_DEV_MODE=true`, auth is skipped (suitable for local dev)
- If the key **is set**, any request to `/mcp` without a matching `x-agentgate-key` header receives a `401 UNAUTHORIZED` response

`.env` entry:

```
AGENTGATE_MCP_KEY=your-long-random-secret
```

### REST API, Admin & Dashboard Authentication

Auth is split into three independent environment variables, each protecting a different surface:

| Variable | Protects | How it's checked |
|---|---|---|
| `AGENTGATE_REST_KEY` | All non-admin POST routes (bonds, actions, markets) | `x-agentgate-key` header |
| `AGENTGATE_ADMIN_KEY` | Admin endpoints (`/admin/ban-identity`, `/admin/unban-identity`) | `x-agentgate-key` header |
| `AGENTGATE_DASHBOARD_KEY` | Dashboard (`/dashboard`) | HTTP Basic Auth (username `admin`, password = key value) |

- **Auth is required by default.** If a key is **not set** and `AGENTGATE_DEV_MODE` is not `true`, requests to that surface are rejected with `500 SERVER_MISCONFIGURED`
- If `AGENTGATE_DEV_MODE=true`, missing keys are allowed and auth is skipped for that surface (suitable for local dev)
- If a key **is set**, requests without a valid credential receive `401 UNAUTHORIZED`
- Each key can be rotated independently without affecting the others

```
AGENTGATE_DEV_MODE=true              # skip auth enforcement for local dev (default: not set — auth required)
AGENTGATE_REST_KEY=your-rest-secret
AGENTGATE_ADMIN_KEY=your-admin-secret
AGENTGATE_DASHBOARD_KEY=your-dashboard-secret
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

**Total: 3 logic bugs fixed, 1 SSRF vulnerability fixed, 29 red team tests passing.**

Full attack scenarios documented in [`docs/red-team-plan.md`](docs/red-team-plan.md).

**Post-v0.2.0 hardening (Session 15):** A cold-eyes security audit identified additional issues that have since been fixed:

- Timestamp validation now rejects future-dated timestamps (>5 seconds ahead) in addition to stale ones, closing a clock-skew attack vector
- Dashboard HTML output is now XSS-safe — all database-backed values are escaped via `escapeHtml()` before interpolation
- MCP HTTP server hardened with a 1MB body size limit, 100-session cap, and automatic cleanup of sessions idle for more than 5 minutes
- Bond locking (`POST /v1/bonds/lock`) now requires Ed25519 signature verification, matching the auth model on all other state-changing endpoints
- Fastify upgraded to 5.8.2

**Post-v0.3.0 hardening (Session 20):**

- Bond TTL capped at 24 hours (86400 seconds) — requests exceeding the cap are rejected with `400 TTL_TOO_LONG`
- Action payload capped at 4096 bytes — oversized payloads are rejected with `400 PAYLOAD_TOO_LARGE`
- SQLite WAL mode enabled for improved concurrent read performance
- SQLite busy timeout set to 5 seconds — database operations wait instead of failing immediately when the database is locked

**Post-v0.3.0 hardening (Session 21):**

- **Fail-closed auth by default** — all auth keys (`AGENTGATE_REST_KEY`, `AGENTGATE_ADMIN_KEY`, `AGENTGATE_MCP_KEY`, `AGENTGATE_DASHBOARD_KEY`) are now required unless `AGENTGATE_DEV_MODE=true` is explicitly set. Missing keys return `500 SERVER_MISCONFIGURED` instead of silently skipping auth
- **SQLite CHECK constraints** — database-level enforcement on bonds (`amount_cents >= 0`, `outstanding_exposure_cents >= 0`, `slashed_cents >= 0`, valid status enum), actions (`exposure_cents >= 0`, valid status enum), and identities (`status IN ('active', 'banned')`). Startup data validation catches violations in existing databases
- **Rate-limit bucket cleanup** — expired `action_execute_buckets` entries (older than 60 seconds) are now pruned on the same 60-second interval as the sweeper and nonce cleanup
- **Demo echo route gated** — `POST /v1/demo/echo` is only registered when `AGENTGATE_DEV_MODE=true`; returns 404 in production
- **Market position filtering at DB level** — `resolveMarket()` now uses `json_extract(payload, '$.marketId')` in the SQL query instead of loading all open positions into memory
- **Market deadline validation** — `resolutionDeadline` must be a valid future ISO 8601 timestamp (enforced via Zod `.refine()`)
- **Payload size measured in bytes** — the 4096 limit now uses `Buffer.byteLength()` instead of `.length`, correctly measuring multi-byte characters

---

## Remote Deployment

AgentGate is deployed to a DigitalOcean droplet (Ubuntu 24.04) at [agentgate.run](https://agentgate.run).

> **Security status:** UFW firewall enabled (ports 22, 80, 443 only — ports 3000 and 3001 are no longer publicly accessible). TLS live via Caddy reverse proxy with auto-managed Let's Encrypt certificates. Auth in place on both services (`x-agentgate-key` on MCP, `x-agentgate-key` + Basic Auth on REST/dashboard).

- **Dashboard:** https://agentgate.run/dashboard
- **MCP endpoint:** https://mcp.agentgate.run/mcp
- **Health check:** https://agentgate.run/health
- **Caddy config:** `/etc/caddy/Caddyfile` on the server — proxies `agentgate.run` → `127.0.0.1:3000` and `mcp.agentgate.run` → `127.0.0.1:3001`

The server is managed by **pm2**, which keeps it running after SSH disconnect and restarts it automatically on crash or reboot.

```bash
pm2 status               # check if agentgate is running
pm2 logs agentgate       # tail live logs
pm2 restart agentgate    # apply updates
pm2 stop agentgate       # stop the server
```

> **Note:** The live demo at agentgate.run (including the dashboard and MCP endpoint) is hosted on a DigitalOcean droplet with a Namecheap domain, both paid through approximately March 2027. After that date, these URLs may no longer be active. The project runs fully on localhost — see the "Running Locally" section to try it yourself.

---

## Built With AgentGate

| Agent | Description |
|---|---|
| [agent-001-file-transform](https://github.com/selfradiance/agent-001-file-transform) | A bonded file-transform agent that accepts a task contract, executes a CSV-to-JSON transformation, verifies the result against a SHA-256 hash, and resolves through AgentGate. First agent in the single-task sandboxed agent pattern. |

---

## Tech Stack

- **Language:** TypeScript (100%)
- **Runtime:** Node.js 20+
- **Web framework:** Fastify
- **Database:** SQLite via better-sqlite3
- **Validation:** Zod
- **Testing:** Vitest (70 tests)
- **MCP SDK:** @modelcontextprotocol/sdk
- **CI:** GitHub Actions (build, lint, and test on every push and PR to main)
- **Reverse proxy:** Caddy (auto-managed TLS)
- **Process manager:** pm2

---

## Project Files

- `src/` — core server logic (Fastify API, service layer, database, signing, structured logging)
- `src/mcp/` — MCP server exposing 7 tools over stdio and Streamable HTTP transports
- `src/agent-adapter.ts` — clean agent-facing interface that hides signing, nonces, and HTTP details
- `src/dashboard.ts` — real-time HTML dashboard
- `src/backup.ts` — automatic database backup on startup (keeps 5 most recent)
- `src/reputation.ts` — reputation scoring function
- `test/` — 70 tests across 6 suites (API, MCP integration, prediction markets, sweeper, red team, outbound HTTP)
- `examples/` — demo agents and adapter demo
- `docs/threat-model.md` — threat model (attacks, defenses, non-goals, assumptions)
- `docs/red-team-plan.md` — 20 adversarial attack scenarios across 5 phases
- `docs/manifesto.md` — "How I Built AgentGate" — the full story
- `.github/workflows/ci.yml` — GitHub Actions CI (build, lint, and test on every push/PR)
- `AGENTS.md` — conventions for AI coding agents
- `LICENSE` — MIT License

---

## License

MIT — see [LICENSE](LICENSE).
