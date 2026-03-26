# AgentGate — Project Context for Claude

**Last updated:** 2026-03-26 (Session 27)
**Owner:** James Toole
**Repo:** https://github.com/selfradiance/agentgate
**Local folder:** ~/Desktop/projects/agentgate
**Skill level:** Beginner — James has no prior coding experience. He directs AI coding agents (Claude Code) to build the project. Explain everything simply. Take baby steps.

---

## What AgentGate Is

AgentGate is a collateralized execution engine for AI agents. It solves the problem of AI agent accountability: before an agent can execute a high-impact action (market orders, API calls, financial operations), it must post a bond as collateral. If the action succeeds, the bond is released. If the agent behaves maliciously, the bond is slashed.

The core insight: as AI agents reduce the marginal cost of sending bids, API calls, and negotiations, systems designed around human friction become vulnerable to synthetic pressure. Rate limits cap volume but don't make bad actions costly. Auth tokens verify identity but don't require skin in the game. AgentGate makes bad behavior economically irrational.

---

## Tech Stack

- **Language:** TypeScript (100%)
- **Web framework:** Fastify
- **Database:** better-sqlite3 (SQLite)
- **Validation:** Zod
- **Testing:** Vitest
- **Runtime:** Node.js 20+, tsx for TypeScript execution
- **MCP SDK:** @modelcontextprotocol/sdk
- **Config:** dotenv (loads .env on startup)
- **Coding tool:** Claude Code

---

## Architecture (Layer by Layer)

┌─────────────────────────────────┐
│  Claude Desktop (MCP Client)    │  ← User talks to Claude here
├─────────────────────────────────┤
│  MCP HTTP Server (port 3001)    │  ← Streamable HTTP transport (http-server.ts)
│  MCP stdio Server (server.ts)   │  ← Alternative: stdio transport
├─────────────────────────────────┤
│  AgentAdapter (agent-adapter.ts)│  ← Hides signing, timestamps, HTTP, nonces
├─────────────────────────────────┤
│  Fastify HTTP API (app.ts)      │  ← REST endpoints with Zod validation (port 3000)
├─────────────────────────────────┤
│  Dashboard (dashboard.ts)       │  ← Real-time HTML dashboard on /dashboard
├─────────────────────────────────┤
│  Service Layer (service.ts)     │  ← Core business logic + sweeper + nonce cleanup
├─────────────────────────────────┤
│  SQLite Database (db.ts)        │  ← Identities, bonds, actions, nonces
└─────────────────────────────────┘

---

## Key Files

| File | Purpose |
|------|---------|
| src/mcp/server.ts | MCP server — exposes 7 tools; has createMcpServer(adapter) factory for testability |
| src/mcp/http-server.ts | MCP Streamable HTTP transport — Express server on port 3001, session management, serves same 7 tools over HTTP |
| src/agent-adapter.ts | Clean agent-facing interface, hides crypto signing and nonce generation; accepts optional identityPath or agentName — named agents get their own agent-identity-{name}.json file |
| src/app.ts | Fastify route handlers (REST API); enforces x-nonce header on all POST routes, records nonces for duplicate detection; exposes sweepExpiredActions() and getDashboardData() for index.ts |
| src/dashboard.ts | Real-time HTML dashboard — shows summary bar, reputation scores, bonds, actions, identities with color-coded statuses, truncated IDs, auto-refresh every 5 seconds |
| src/service.ts | Core logic — bond locking, action execution, resolution, slashing, expired action sweeping, nonce TTL cleanup, createMarket(), resolveMarket() |
| src/signing.ts | Ed25519 cryptographic signing and verification |
| src/http.ts | Outbound HTTP safety rails (allowlist, timeout, size limits) |
| src/schemas.ts | Zod validation schemas for all endpoints |
| src/types.ts | TypeScript type definitions |
| src/backup.ts | Database backup — copies SQLite file on startup, keeps 5 most recent backups |
| src/logger.ts | Structured JSON logger — outputs to stderr, generates request IDs (8 hex chars) |
| src/reputation.ts | Reputation scoring function |
| src/db.ts | SQLite database setup and schema (identities, bonds, actions, nonces tables) |
| src/errors.ts | Custom error class |
| src/index.ts | Entry point — starts Fastify server + 60-second sweeper/nonce-cleanup interval with clean shutdown |
| examples/adapter-demo.ts | End-to-end adapter demo script |
| examples/toy-agent.ts | Original toy agent example |
| test/app.test.ts | Comprehensive HTTP API + nonce replay protection test suite |
| test/mcp-integration.test.ts | End-to-end MCP integration test (all 5 original tools) |
| test/market.test.ts | Prediction market tests — happy path, double-resolution rejection, cross-market isolation |
| test/sweeper.test.ts | Sweeper tests for expired action auto-slashing |
| test/red-team.test.ts | Red team adversarial test suite — invariant validator + 20 attack scenarios across 5 phases (bond math, sweeper, replay, concurrency, outbound HTTP) |
| docs/threat-model.md | Threat model — attacks, defenses, non-goals, assumptions |
| docs/roadmap/day1-integration-surface.md | Integration surface design doc |
| AGENTS.md | Conventions for AI coding agents |

---

## MCP Tools (7 tools exposed to Claude Desktop)

1. **create_identity** — Creates or loads an Ed25519 identity (auto-called by other tools)
2. **lock_bond** — Locks a bond (stake) for an identity. Inputs: amount_cents, ttl_seconds, reason
3. **execute_bonded_action** — Executes an action through the gate. Inputs: bondId, actionType, payload, exposure_cents
4. **resolve_action** — Resolves an action as success/failed/malicious. Inputs: actionId, outcome
5. **get_reputation** — Gets identity reputation score. Inputs: identityId
6. **create_market** — Creates a prediction market with a yes/no question and resolution deadline. Inputs: question, resolution_deadline
7. **resolve_market** — Resolves an open market as yes/no, auto-settles all positions. Inputs: marketId, outcome

---

## Core Concepts

### Identity
- Ed25519 public key (raw 32-byte base64)
- All state-changing endpoints require signed requests
- Replay protection via timestamp validation (60-second window) AND nonce store (duplicate rejection)
- Identity persisted to agent-identity.json (gitignored — contains private key)
- Named agents: set AGENTGATE_AGENT_NAME=trader env var (MCP) or pass agentName to AgentAdapter constructor — creates a separate agent-identity-trader.json file and stores the name in the database; all agent-identity*.json files are gitignored via wildcard

### Bonds
- Reusable — one bond can cover multiple concurrent actions
- Capacity rule: effective_exposure = ceil(declared_exposure × 1.2)
- Constraint: outstanding_exposure + effective_exposure <= amount_cents
- If exceeded → INSUFFICIENT_BOND_CAPACITY error
- Bond status lifecycle: active → occupied (when action attached) → released / burned / slashed

### Exposure Lifecycle
- **Execute:** exposure reserved, outstanding_exposure_cents incremented, bond marked occupied
- **Resolve (success/failed):** exposure released, bond status set to released
- **Resolve (malicious):** bond amount reduced (clamped at 0), slashed_cents increased, bond burned

### Nonce Store (Replay Protection)
- All POST endpoints require an x-nonce header (400 error if missing). The nonce is cryptographically bound into the signed message (`sha256(nonce + method + path + timestamp + body)`), preventing replay with a fresh nonce.
- Nonces table has composite primary key (nonce, identity_id) — same nonce can be used by different identities, but same identity cannot reuse a nonce
- After signature verification, the nonce is recorded via INSERT OR IGNORE — if 0 rows inserted, returns 409 DUPLICATE_NONCE
- create_identity and echo routes require the header but skip duplicate detection (no identity context yet)
- AgentAdapter automatically generates a random UUID nonce for every request
- cleanExpiredNonces() runs every 60 seconds alongside the sweeper, deleting nonces older than 5 minutes (well beyond the 60-second signature window)

### Auto-Slash Sweeper
- sweepExpiredActions() runs every 60 seconds via setInterval in index.ts
- Finds all actions with status 'open' where the associated bond's expires_at is in the past
- Resolves each expired action as 'malicious' using the full resolveAction() settlement logic
- Logs [sweeper] slashed N expired actions every tick so you can see it's alive
- Clean shutdown: SIGINT (Ctrl+C) and SIGTERM clear the interval before closing the server

### Prediction Markets
- Markets are yes/no questions with a question string and a resolution deadline (ISO timestamp)
- Agents take positions via `execute_bonded_action` with `actionType: "market.position"` and `payload: { marketId, side }` where side is `"yes"` or `"no"`
- `resolveMarket(marketId, outcome)` batch-settles all open positions on that market: correct side → `success` (bond released), wrong side → `failed` (bond burned)
- Double resolution is rejected with `MARKET_ALREADY_RESOLVED` (409)
- Cross-market isolation: resolving one market only settles positions whose payload references that marketId — positions on other markets are unaffected
- Occupied bonds now correctly accept concurrent actions (capacity permitting): `assertBondCanBackAction` allows both `active` and `occupied` bond status

### Safety Rails
- Rate limiting: 10 executes per 60 seconds per identity
- Progressive minimum bond: higher bond required as action volume increases
- Replay protection via nonce store (duplicate nonce rejection per identity) AND nonce bound into signed message (prevents replay with fresh nonce)
- Outbound HTTP: allowlist enforcement, timeout, max request/response size
- Ed25519 signature verification on all state-changing requests; signed message = `sha256(nonce + method + path + timestamp + body)`
- Auto-slash on expired bonds (sweeper)
- Identity governance: auto-ban after 3 malicious resolutions, manual ban/unban via admin API

### Reputation Scoring
- Formula: locks×2 + actions×3 + successes×10 - failures×5 - malicious×20

---

## Dashboard

- **URL (local):** http://127.0.0.1:3000/dashboard — **URL (remote):** https://agentgate.run/dashboard
- **Summary bar:** identity count, bond count, active bonds, action count
- **Reputation Scores table:** per-identity score with color coding (green positive, red negative, gray zero)
- **Bonds table:** all bonds with truncated IDs, color-coded status, hover for full values
- **Actions table:** all actions with truncated payloads, color-coded status
- **Identities table:** all identities with truncated public keys
- **Auto-refresh:** page reloads every 5 seconds

---

## How to Run

### Start the AgentGate server:
cd ~/Desktop/projects/agentgate
npm run restart

This kills any old server process on port 3000, then starts fresh.
Fastify REST API runs on http://127.0.0.1:3000
MCP HTTP server starts automatically on http://127.0.0.1:3001/mcp
Dashboard at http://127.0.0.1:3000/dashboard
Sweeper and nonce cleanup logs appear every 60 seconds.
Both servers shut down together on Ctrl+C (SIGINT) or SIGTERM.
Database file: data/agentgate.sqlite (created automatically on first run)
Backups: data/backups/ (one backup per startup, 5 most recent kept, older ones auto-deleted)

### Claude Desktop MCP config:
File: ~/Library/Application Support/Claude/claude_desktop_config.json

**Option A — HTTP transport via mcp-remote, local (recommended):**
{
  "mcpServers": {
    "agentgate": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:3001/mcp"]
    }
  }
}

**Option A2 — HTTP transport via mcp-remote, remote (agentgate.run):**
{
  "mcpServers": {
    "agentgate": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.agentgate.run/mcp"]
    }
  }
}

**Option B — stdio transport (local only):**
{
  "mcpServers": {
    "agentgate": {
      "command": "/Users/jamestoole/Desktop/projects/agentgate/node_modules/.bin/tsx",
      "args": ["/Users/jamestoole/Desktop/projects/agentgate/src/mcp/server.ts"]
    }
  }
}

To run a named agent with stdio (e.g. "trader"), add an env field:

{
  "mcpServers": {
    "agentgate-trader": {
      "command": "/Users/jamestoole/Desktop/projects/agentgate/node_modules/.bin/tsx",
      "args": ["/Users/jamestoole/Desktop/projects/agentgate/src/mcp/server.ts"],
      "env": { "AGENTGATE_AGENT_NAME": "trader" }
    }
  }
}

The AgentGate HTTP server (npm run restart) MUST be running for MCP tools to work.

### Remote Server (DigitalOcean):
- **Domain:** agentgate.run (registered on Namecheap)
- **Server IP:** 174.138.63.42
- **Provider:** DigitalOcean, Ubuntu 24.04, $4/month droplet
- **To connect:** ssh root@174.138.63.42 (passwordless — Ed25519 SSH key configured)
- **To start:** cd agentgate && pm2 restart agentgate
- **Dashboard:** https://agentgate.run/dashboard
- **MCP endpoint:** https://mcp.agentgate.run/mcp
- Both Node servers bind to 127.0.0.1 — only accessible via Caddy reverse proxy
- ✅ UFW firewall enabled — only ports 22 (SSH), 80 (HTTP), 443 (HTTPS) are open; ports 3000 and 3001 are no longer publicly accessible
- ✅ TLS live via Caddy reverse proxy with auto-managed Let's Encrypt certificates
- ✅ Auth in place on both services (x-agentgate-key on MCP, x-agentgate-key + Basic Auth on REST/dashboard)
- **Caddy config:** /etc/caddy/Caddyfile — agentgate.run → 127.0.0.1:3000, mcp.agentgate.run → 127.0.0.1:3001
- **Process manager:** pm2 keeps the server running in the background, auto-restarts on crash, auto-starts on reboot
- **Useful pm2 commands:** pm2 status, pm2 logs agentgate, pm2 restart agentgate, pm2 stop agentgate

### Run tests:
npm run test

All 94 tests across 10 files should pass.

---

## Completed Milestones (in order)

1. ✅ Initial IBP prototype
2. ✅ Ed25519 request signing
3. ✅ Per-identity rate limiting and progressive minimum bond
4. ✅ MarketGate demo with mock exchange and outbound safety rails
5. ✅ Reusable bond capacity model with exposure tracking
6. ✅ Day 1 integration surface design doc
7. ✅ AgentAdapter layer (hides signing, timestamps, HTTP details)
8. ✅ End-to-end adapter demo with echo endpoint
9. ✅ MCP thin wrapper (5 tools over stdio)
10. ✅ Bug fixes: exposure_cents field naming consistency
11. ✅ Bug fixes: MCP response format (type:"text"), string coercion (z.coerce), payload parsing (z.preprocess), identity file path (import.meta.url)
12. ✅ Security: removed private key from git, added agent-identity.json to .gitignore
13. ✅ Package renamed from ibp-prototype to agentgate
14. ✅ .env.example cleaned up
15. ✅ Full live demo loop: create identity → lock bond → execute bonded action → resolve success → check reputation (score: 17) — ALL WORKING
16. ✅ MCP integration test: all 5 tools tested end-to-end via InMemoryTransport (no subprocess)
17. ✅ Bug fix: resolveAction now correctly calls calculateSettlement and updates bond status
18. ✅ Bug fix: executeAction marks bond as 'occupied' after action attached
19. ✅ Bug fix: exposure_cents made optional with default 0 in schemas.ts
20. ✅ Refactor: createMcpServer(adapter) factory extracted for testability; AgentAdapter accepts optional identityPath
21. ✅ Threat model doc added (docs/threat-model.md) — covers attacks, defenses, non-goals, assumptions
22. ✅ README rewritten: added "Why AgentGate?" section with synthetic pressure framing, linked threat model
23. ✅ README: added "Quick Integration" section with 4-step HTTP flow and common errors table
24. ✅ Auto-slash sweeper: sweepExpiredActions() in service.ts, 60s background interval in index.ts, clean shutdown via SIGINT/SIGTERM, old duplicate sweepTimedOutActions removed, threat model updated, sweeper tests added (18 total tests)
25. ✅ Dashboard: real-time HTML dashboard at /dashboard with summary bar, reputation scores (color-coded), bonds/actions/identities tables with truncated IDs, status color coding, auto-refresh every 5 seconds
26. ✅ Added npm run restart script — kills old server processes on port 3000 before starting fresh
27. ✅ Structured logging: JSON logger with request IDs wired into HTTP layer (app.ts), sweeper (index.ts), and MCP server (server.ts); all output goes to stderr to avoid corrupting MCP stdio protocol
28. ✅ Persistent bond state: renamed database to agentgate.sqlite, renamed env var to AGENTGATE_DB_PATH, added startup backup to data/backups/ with auto-pruning (keeps 5), data/ added to .gitignore
29. ✅ Multi-agent support: AgentAdapter accepts optional agentName, creates separate identity files per agent (agent-identity-{name}.json), agent_name column added to identities table with ALTER TABLE migration for existing databases, dashboard shows agent name per identity and in reputation scores, wildcard .gitignore pattern covers all agent identity files
30. ✅ v0.1.0 tagged and pushed — README cleaned up (removed internal workflow section, added Dashboard section, updated Project Files, updated Running Locally), renamed all IBP_ environment variables to AGENTGATE_ prefix across src/http.ts, README.md, and .env.example
31. ✅ Nonce store for replay protection: nonces table with composite primary key (nonce, identity_id), x-nonce header required on all POST routes, duplicate detection via INSERT OR IGNORE returning 409, AgentAdapter auto-generates UUID nonces, cleanExpiredNonces() purges nonces older than 5 minutes on 60-second interval, 3 new tests (21 total), README updated
32. ✅ MCP Streamable HTTP transport: Express server on port 3001 serving all 5 MCP tools via StreamableHTTPServerTransport with session management, mcp-remote bridge for Claude Desktop, both servers start together and shut down together
33. ✅ Remote deployment: DigitalOcean droplet (Ubuntu 24.04, NYC), Node.js 20 installed, repo cloned, servers bind to 0.0.0.0, dashboard accessible at public IP on port 3000, MCP endpoint on port 3001
34. ✅ UFW firewall enabled on remote server — ports 22, 3000, 3001 only; all other inbound traffic blocked
35. ✅ MCP endpoint authentication: static shared-secret header (x-agentgate-key) on MCP HTTP server, middleware in http-server.ts, env var AGENTGATE_MCP_KEY loaded via dotenv, 401 for unauthorized requests, warning logged when key not set
36. ✅ REST API + dashboard authentication: shared-secret header (x-agentgate-key) on all POST routes, HTTP Basic Auth on /dashboard with browser login popup, env var AGENTGATE_REST_KEY, skips auth when key not set (local dev friendly), README updated
37. ✅ pm2 process manager on remote server: AgentGate stays running after SSH disconnect, auto-restarts on crash, auto-starts on droplet reboot (pm2 startup + pm2 save)
38. ✅ TLS via Caddy reverse proxy: domain agentgate.run registered, Caddy installed on DigitalOcean server, auto-managed Let's Encrypt certificates for agentgate.run and mcp.agentgate.run, UFW updated to allow only ports 22/80/443 (3000/3001 no longer publicly accessible), Node servers now bind to 127.0.0.1
39. ✅ GET /health endpoint: unauthenticated health check at /health returning JSON status and timestamp, for use by external uptime monitors
40. ✅ UptimeRobot uptime monitoring: free external monitor checking https://agentgate.run/health every 5 minutes, emails on downtime
41. ✅ Structured security event logging: all security-relevant events (auth_failed, duplicate_nonce, signature_failed, bond_slashed, outbound_blocked) now logged with clear event fields and context via the structured logger; logger.ts extended to accept optional metadata object
42. ✅ SSH key authentication: Ed25519 SSH key set up on local Mac and copied to DigitalOcean server — passwordless deploys via ssh root@174.138.63.42
43. ✅ Red team Phase 0: invariant validator — validateInvariants(db) checks 8 database invariants (bond amounts, exposure accounting, settlement consistency, nonce uniqueness), exported from test/red-team.test.ts, used as backbone for all adversarial tests
44. ✅ Red team Phase 1: bond/exposure math — 6 attack tests (over-commit, rapid cycles, double-resolve, burned bond, zero/negative exposure, overflow), found and fixed slashed_cents persistence bug and negative exposure gap
45. ✅ Red team Phase 2: sweeper edge cases — 3 attack tests (resolve race, double-slash, expired bond execute), sweeper logic confirmed solid
46. ✅ Red team Phase 3: replay attacks — 3 attack tests (exact duplicate, in-window replay, parallel nonce), Attack 3.3 documented as safe by design (timestamp window closes before nonce TTL cleanup)
47. ✅ Red team Phase 4: SQLite concurrency — 2 attack tests (50 parallel executes, parallel resolve+execute), better-sqlite3 serialization confirmed sound
48. ✅ Red team Phase 5: outbound HTTP — 9 attack tests (IPv6, encoded IPs, non-HTTP schemes, redirect targets), found and fixed redirect bypass SSRF vulnerability and IPv6 bracket allowlist bug
49. ✅ Red team plan document added at docs/red-team-plan.md — 20 attack scenarios across 5 phases
50. ✅ v0.2.0 tagged and pushed — Security & Adversarial Hardening release, 48 tests across 5 red team phases, 3 bugs fixed, 1 SSRF vulnerability closed
51. ✅ Identity governance: status field on identities (active/banned), admin ban/unban endpoints (POST /admin/ban-identity, POST /admin/unban-identity) protected by API key, auto-ban after 3 malicious resolutions with security event logging, banned identities rejected at lockBond and executeAction with 403 IDENTITY_BANNED, dashboard shows status column and [BANNED] tag on reputation scores, 5 new tests (53 total)
52. ✅ Prediction market demo: markets table, MarketRecord type, createMarket/resolveMarket service methods, Zod schemas, two REST endpoints (POST /markets, POST /markets/:marketId/resolve), two new MCP tools (7 total), two adapter methods, dashboard shows markets with summary stat and table, 3 market tests (happy path, double-resolution rejection, cross-market isolation), fix: occupied bonds now correctly accept concurrent actions (56 total tests)
53. ✅ MIT License: added LICENSE file (MIT, 2025, James Toole) — repo is now legally open source
54. ✅ GitHub Actions CI: .github/workflows/ci.yml runs npm ci and npm test on every push and PR to main, green checkmark on repo
55. ✅ SSH authentication for GitHub: Ed25519 SSH key linked to GitHub account, remote switched from HTTPS to SSH, resolves workflow scope permission issue with PAT
56. ✅ Manifesto published: "The AgentGate Manifesto — Why AI Agents Need Skin in the Game" written and published to Hacker News, framing the economic accountability thesis for a public audience
57. ✅ Personal process template formalized: internal development playbook captured as a standalone document (not included in repo — private reference only)
58. ✅ Session 13: Desktop reorganized — ~/Desktop/projects/ folder created, agentgate and restarules moved inside it. All future projects live at ~/Desktop/projects/<project-name>. Strategic direction decided via three-way AI audit (Claude + ChatGPT + Gemini): next project is agent-001-file-transform, a separate repo that uses AgentGate as its enforcement substrate.
59. ✅ Session 14: Three-way audit cleanup (Claude + ChatGPT + Gemini identified 5 issues; 2 were false positives). README fully rewritten to match current project state — added CI badge, nonce replay protection details, auto-slash sweeper, reputation scoring, multi-agent support, expanded tech stack, expanded project files listing, removed stale MarketGate demo section. GitHub Releases published for v0.1.0 (Core Engine) and v0.2.0 (Security & Adversarial Hardening). "Built With AgentGate" section added to README pointing to agent-001-file-transform.
60. ✅ Session 15: Cold-eyes security audit (ChatGPT) — reviewed full repo from GitHub URL with no project context. Identified 10 findings across identity model, timestamp validation, dashboard XSS, MCP HTTP hardening, bond auth, secret management, and dependency versions.
61. ✅ Fix: isFreshTimestamp now rejects future-dated timestamps (>5s ahead), closing clock-skew attack vector. New test added.
62. ✅ Fix: Dashboard stored XSS — escapeHtml() applied to all database-backed values interpolated into HTML. Static template strings left untouched.
63. ✅ Fix: MCP HTTP hardening — express.json body limit (1MB), session cap (100 max), idle session timeout (5 min TTL with 60s cleanup interval).
64. ✅ Fix: Bond locking now requires Ed25519 signature verification, matching action execution auth model. 2 new tests added. (59 total tests)
65. ✅ Fastify upgraded from 5.6.1 to 5.8.2, closing known security advisories.
66. ✅ Fix: Auth secrets split into three roles — AGENTGATE_REST_KEY (API), AGENTGATE_ADMIN_KEY (admin endpoints), AGENTGATE_DASHBOARD_KEY (dashboard Basic Auth). Each skips auth independently when not set.
67. ✅ Documented: Identity model Sybil limitation added to docs/threat-model.md Known Limitations — no public_key uniqueness, no proof-of-possession, future hardening options noted.
68. ✅ Documented: Unauthenticated GET endpoints (/health, /v1/stats, /v1/identities/:id) documented as intentional in threat model.
69. ✅ Fix: Dashboard Basic Auth now uses crypto.timingSafeEqual for constant-time password comparison.
70. ✅ Fix: MCP payload JSON.parse failure now returns clean validation error instead of raw SyntaxError.
71. ✅ Fix: Bond accounting for multi-action bonds — resolveAction() now subtracts the resolved action's exposure instead of zeroing outstanding_exposure_cents. Bond status stays "occupied" until all open actions resolve. Validation reordered so bond status is checked before capacity. New test proves correct accounting across two concurrent actions. (61 total tests)
72. ✅ Fix: Stranded action cleanup on failed outbound HTTP — new rollbackFailedAction() method atomically marks the action as "failed" and releases bond exposure when postJson or URL validation fails. Bond returns to "active" if no other open actions remain. New test confirms cleanup. (61 total tests)
73. ✅ README updated for Session 16: test count 59→61, auth section rewritten for three-key split (REST_KEY, ADMIN_KEY, DASHBOARD_KEY), exposure lifecycle updated to document multi-action bond support.
74. ✅ Fix: Settlement math now action-scoped — calculateSettlement() uses action.exposure_cents instead of bond.amount_cents, so shared-bond settlement (slash, refund, burn) applies only to the resolved action's reserved exposure, not the entire bond.
75. ✅ Fix: rollbackFailedAction() idempotency guard — checks action status is still 'open' before modifying bond exposure, preventing double-subtraction if called twice.
76. ✅ Fix: REST and admin API key comparisons now use crypto.timingSafeEqual for constant-time comparison, matching dashboard auth pattern. Closes timing side-channel vector.
77. ✅ Fix: Signatures now bound to HTTP method and path — signed message format changed from sha256(timestamp + body) to sha256(method + path + timestamp + body), preventing cross-endpoint replay attacks.
78. ✅ Fix: Identity registration now requires proof-of-possession — POST /v1/identities verifies Ed25519 signature using the public key being registered, preventing unauthorized key registration.
79. ✅ README updated for Session 17: signed message format updated in 4 locations, identity registration now documents proof-of-possession, Quick Integration step 1 fixed to /v1/identities with signature headers.
80. ✅ Fix: Public key uniqueness enforced — UNIQUE constraint on identities.public_key column, migration adds unique index for existing databases, duplicate registration returns 409 DUPLICATE_IDENTITY. New test added. (62 total tests)
81. ✅ Fix: Production auth guards — server refuses to start when NODE_ENV=production if any of AGENTGATE_REST_KEY, AGENTGATE_ADMIN_KEY, or AGENTGATE_MCP_KEY are missing. Non-production behavior unchanged. Guard added to both index.ts and mcp/http-server.ts.
82. ✅ CI pipeline expanded — build and lint steps added to GitHub Actions workflow (now runs build → lint → test).
83. ✅ Version bumped to 0.3.0 in package.json.
84. ✅ README updated for v0.3.0: identity uniqueness, production auth guards, expanded CI pipeline, test count 61→62.
85. ✅ Fix: All TypeScript build errors resolved — type assertions in mcp-integration.test.ts, CJS-compatible path resolution in agent-adapter.ts and mcp/server.ts, signedRequest→signedPost method fix in agent-adapter.ts, dashboard return type in app.ts. Build and lint pass clean. (62 total tests)
86. ✅ v0.3.0 tagged and pushed — cold-eyes security audit complete, build errors fixed, CI expanded with build+lint steps.
87. ✅ Fix: Outbound HTTP allowlist now checks host:port pairs — supports host:* wildcard for local dev, explicit host:port for production configs. Error messages updated. 3 new tests (65 total).
88. ✅ Fix: Outbound response sanitization — raw downstream response bodies are sanitized before database persistence: headers stripped, body truncated to 1024 chars with [truncated] marker. Full result still returned to caller.
89. ✅ Fix: Bond settlement fields persisted — refund_cents, burned_cents, and closed_at now written to the bond record during resolution. closed_at set when no open actions remain. 2 new tests (67 total).
90. ✅ Fix: Bond TTL capped at 86400 seconds (24 hours) — requests exceeding the cap rejected with 400 TTL_TOO_LONG. 1 new test (68 total).
91. ✅ Fix: Action payload size capped at 4096 characters — oversized payloads rejected with 400 PAYLOAD_TOO_LARGE. 1 new test (69 total).
92. ✅ Fix: SQLite operational hardening — WAL mode enabled for better concurrent read performance, busy_timeout set to 5000ms to avoid immediate lock failures.
93. ✅ README updated for Session 20: test count 62→69, outbound HTTP host:port allowlist, response sanitization, bond settlement field persistence, TTL cap, payload cap, WAL mode.
94. ✅ Security fix: nonce bound into Ed25519 signed message — signed message format changed from `sha256(method+path+timestamp+body)` to `sha256(nonce+method+path+timestamp+body)`, closing a replay bypass where a captured signed request could be replayed with a fresh nonce. Updated signing.ts, app.ts, agent-adapter.ts, and all test files.
95. ✅ Fix: test nonce strings changed to UUID-format (`${string}-${string}-${string}-${string}-${string}`) to satisfy TypeScript template literal type constraint.
96. ✅ README signed message format updated in all 3 occurrences to reflect nonce-bound signature: `sha256(nonce + method + path + timestamp + body)`. Commit d4d173d.
97. ✅ Fix: Auth now fails closed by default — missing REST/admin/MCP keys return 500 SERVER_MISCONFIGURED unless AGENTGATE_DEV_MODE=true is set. Replaces old NODE_ENV=production startup guard with per-request enforcement. vitest.config.ts added to set dev mode for tests. Commit d54ca15.
98. ✅ Fix: SQLite CHECK constraints added to bonds (amount_cents >= 0, outstanding_exposure_cents >= 0, slashed_cents >= 0, valid status), actions (exposure_cents >= 0, valid status), and identities (valid status). Startup data validation migration checks existing databases for violations. Commit 094cc7b.
99. ✅ Fix: Rate-limit bucket cleanup — cleanExpiredBuckets() deletes entries older than 60 seconds, runs on the existing 60-second interval alongside sweeper and nonce cleanup. Commit 9765b77.
100. ✅ Fix: Demo echo route (/v1/demo/echo) gated behind AGENTGATE_DEV_MODE — route is not registered in production. Commit f82ebf3.
101. ✅ Fix: Market resolution filtered at DB level using json_extract(payload, '$.marketId') instead of loading all open actions and filtering in JavaScript. Commit c7cc36f.
102. ✅ Fix: Market deadline validation — resolutionDeadline must be a valid future ISO 8601 timestamp. Payload size check changed from character count to Buffer.byteLength (bytes). Commit 306fbde.
103. ✅ README updated for Session 21: fail-closed auth with AGENTGATE_DEV_MODE, DB CHECK constraints, bucket cleanup, echo route gating, json_extract market filtering, deadline validation, byte-based payload size. Commit cfe284e.
104. ✅ Fix: MCP HTTP server key comparison now uses timingSafeEqual, matching Fastify auth pattern.
105. ✅ Fix: Market resolution now rejects resolution before the stored resolution_deadline. New test added. (70 total tests)
106. ✅ Fix: resolveAction() race window closed — action status check moved inside transaction, UPDATE guarded with WHERE status = 'open', concurrent loser gets clean 409 instead of 500.
107. ✅ SECURITY.md added — vulnerability reporting via GitHub private disclosure, coordinated disclosure policy, scoped to src/, REST API, MCP, dashboard, and deployment config. Private vulnerability reporting enabled in GitHub repo settings.
108. ✅ Fix: stale dbPath fallback in app.ts changed from "data/ibp.sqlite" to "data/agentgate.sqlite" — cosmetic consistency fix found during 8-round audit.
109. ✅ Fix: Dashboard auth now fails closed when AGENTGATE_DASHBOARD_KEY is not set, returning 500 SERVER_MISCONFIGURED unless AGENTGATE_DEV_MODE=true. Matches all other auth surfaces. Found in audit round 1.
110. ✅ Fix: Max-length constraints added to Zod schemas — actionType (128), agentName (64), identityId (64), bondId (64). Defense-in-depth against oversized string storage. Found in audit round 3.
111. ✅ Fix: IbpService renamed to AgentGateService across service.ts, app.ts, market.test.ts, red-team.test.ts. Zero stale references confirmed by grep. Found in audit round 5.
112. ✅ Fix: Secondary database indexes added — actions(bond_id, status), actions(identity_id), bonds(identity_id). Performance optimization for scale. Found in audit round 5.
113. ✅ Fix: README accuracy — AGENTGATE_DASHBOARD_KEY added to fail-closed auth key list, red team test count corrected from 48 to 29, Quick Integration curl examples now note AGENTGATE_DEV_MODE=true assumption. Found in audit round 7.
114. ✅ Fix: 3 high transitive CVEs resolved via npm audit fix (hono serveStatic, setCookie, express-rate-limit in MCP SDK deps). Zero vulnerabilities remaining. Found in audit round 8.
115. ✅ 8-round Claude Code audit completed — Auth & Identity, Settlement & Bond Math, Input Validation, Concurrency & Race Conditions, Database Integrity, Outbound & Attack Surface, Documentation Accuracy, Dependency & Supply Chain. 9 findings across 8 rounds, all fixed. Rounds 2, 4, and 6 passed clean with zero findings.
116. ✅ Agent 001 (agent-001-file-transform) fully complete — v0.1.0 tagged, 36 tests passing (including 25 adversarial edge cases), cold-eyes security audit fixed 11 issues, GitHub Actions CI green. Full bond/execute/resolve lifecycle working against AgentGate API from an external codebase.
117. ✅ Medium article published: "What Happens When an AI Agent Has to Post Collateral Before It Acts?" — audited by ChatGPT and Gemini (2 rounds each) before publishing. Twitter/X distribution: 6-tweet thread, X Article, and 4 community-targeted tweets. README updated with article link in "Built With AgentGate" section.
118. ✅ Agent 004 v0.3.0 (Red Team Simulator) fully complete — three stages shipped: static (15 predefined attacks), adaptive (Claude-powered strategist, 48 scenarios across 12 categories), recursive (Claude generates novel JavaScript attack code executed in sandboxed child process with 4-layer defense). 100 tests passing. 8-round Claude Code audit completed per stage. Novel attack flagged /health endpoint — audited and confirmed false positive (hardcoded response, no reflection). README updated with Agent 004 in "Built With AgentGate" section.
119. ✅ Agent 002 (agent-002-file-guardian) fully complete — v0.2.0 tagged, 50 tests passing (44 passed, 6 skipped), two 8-round Claude Code audits (v0.1.0 and v0.2.0), configurable command-based verification, atomic restores, per-file locking, fail-closed default. Medium article published: "What If Your AI Coder Had Skin in the Game?" with X distribution.
120. ✅ Agent 003 (agent-003-email-rewriter) fully complete — v0.1.0 tagged, 11 tests passing, 8-round Claude Code audit completed, human-in-the-loop verdict (approve/reject) proving subjective judgment in the bond loop. Medium article written and submitted to Coding Nexus (pending review). X distribution complete.
121. ✅ README updated with Agents 002 and 003 in "Built With AgentGate" section — all four agents now listed.
122. ✅ Codex audit (process template v3) — 6 initial findings (1 critical, 2 high, 2 medium, 1 low). Critical: agents could self-resolve their own actions (SELF_RESOLUTION_FORBIDDEN added). High: market endpoints lacked Ed25519 signatures (now required), market resolution could partially fail on malformed payloads (now validates all payloads before marking resolved). Medium: adapter never sent auth key (now sends x-agentgate-key), empty HTTP responses caused 500 (now returns empty string). Low: identity registration nonce not recorded (now recorded). Additional Codex findings on subsequent passes: banned-identity enforcement, adapter identity bootstrapping, bond status aggregation, WAL-safe backups, MCP log sanitization. All fixed iteratively until Codex audit returned clean. 84 tests across 8 files.
123. ✅ Claude Code cross-audit of Codex changes — 15 findings (1 critical, 5 high, 5 medium, 4 low). Critical: market creator could self-resolve their own positions (CREATOR_CANNOT_TAKE_POSITION added). High: bond expiration TOCTOU race (check moved inside transaction), dashboard accepted any username (now requires "admin"), silent catch-all in market settlement (narrowed to ACTION_ALREADY_RESOLVED only), protocol-relative redirect not blocked (now blocked), malformed resolution deadline allowed premature resolution (now validated). Medium: dashboard title attribute uncapped (capped at 256 chars), agent name path traversal (validated against path separators), weak request ID entropy (now crypto.randomUUID), nonce not recorded on early-exit paths (reordered all routes), fragile SQLite error detection (now checks error message). Low: nonce TTL vs signature window documented, dual naming in adapter interfaces cleaned up, sweep interval cleanup added to onClose, error code inconsistency documented. All fixed iteratively. 94 tests across 10 files.
124. ✅ Second Claude Code audit pass — 6 medium, 4 low findings. Fixed 4 (exposure_cents capped at 1B, market deadline capped at 1 year, MCP transport close errors now logged, MCP schemas tightened from z.coerce.number to z.number). Remaining 6 documented as accepted design trade-offs: unauthenticated GET endpoints (intentional), no GET rate limiting (operational), unbounded dashboard SELECT (acceptable at scale), permissive timestamp parsing (backward compatibility), no registration rate limit (bounded by signature compute), no CSRF (dashboard is read-only).
125. ✅ Third Claude Code audit pass — clean. Zero findings at any severity level. All 24 previously fixed items verified. All 6 documented limitations confirmed with code comments. 94 tests across 10 files.
126. ✅ Agent 004 recursive red team run against hardened AgentGate (post-audit). 55 total attacks (40 library + 15 novel). 45 caught, 10 reported as uncaught. Investigation found zero genuinely new vulnerabilities — uncaught findings were: already-documented design decisions (unauthenticated GET endpoints), Agent 004 misinterpreting self-resolution blocking (auto-ban appeared broken because Agent 004 couldn't resolve its own actions to trigger it), and capacity math misunderstandings. Auto-ban mechanism confirmed working via new dedicated test. 95 tests across 10 files.
127. ✅ Agent 004 v0.5.0 (Coordinated Swarms) shipped — 3 teams × 3 agents (9 identities), 5-round campaigns with per-team Claude-powered strategists and informational campaign coordinator. Canonical run: 97 attacks (Alpha 37, Beta 22, Gamma 38), 77 caught, 20 uncaught, 0 swarm-emergent findings. Gamma 100% catch rate (38/38) — economic pressure fully contained. Beta team: 48 clean bond cycles in trust-building phase, offensive phase confirmed no reputation-gated bond capacity. Coordinator synthesis ran every round, demonstrably influenced team strategy. 73 intel log entries, ~5 minutes runtime. 330 tests across 34 files. 8-round Claude Code audit (14 fixes, round 8 clean) + Codex cold-eyes audit (4 findings: 3 medium, 1 low, all fixed, Claude Code cross-verified). Key finding: bond capacity is mathematically enforced but not reputation-gated — any identity can lock any bond up to capacity regardless of track record. Documented as AgentGate enhancement opportunity, not a vulnerability. Agent 004 red team arc complete through v0.5.0.

---

## Known Issues / Tech Debt

- **Single-instance only** — SQLite + in-memory assumptions break under multiple Node processes
- **Dashboard SELECT * unbounded** — no LIMIT on dashboard queries. Acceptable at current scale.
- **No rate limiting on public GET endpoints or identity registration** — operational hardening, not yet implemented.
- **Bond capacity is not reputation-gated** — any identity can lock any bond amount up to capacity regardless of track record. Capacity is mathematically enforced (exposure × 1.2 ≤ bond amount), but there is no progressive trust model (e.g., new identities restricted to small bonds). Systems requiring progressive trust should implement bond caps at the application layer. Surfaced by Agent 004 v0.5.0 Team Beta's trust exploitation testing.

---

## Strategic Reference Targets

### OpenClaw as AgentGate Reference Target (added March 2026)

OpenClaw (open-source autonomous AI agent, 167k+ GitHub stars) has a well-documented vulnerability catalog — prompt injection via untrusted inputs, privilege escalation, supply chain risk from third-party skills, and tool misuse — that maps directly onto the bond-and-slash threat model. Planned use: reference these vulnerability classes as real-world evidence for AgentGate's value. Framing: "class of vulnerabilities autonomous agents face," not OpenClaw-specific criticism. Sequencing: TransformFile agent → Red Team Simulator → OpenClaw reference integration.

---

## Next Steps (in priority order)

1. Write Medium article for Agent 004 — v0.5.0 is the article candidate. All five stages shipped (static → adaptive → recursive → coordinated team → coordinated swarms). Audit trail: 8-round Claude Code audit (14 fixes) + Codex cold-eyes audit (4 fixes) + Claude Code cross-verification = triple-audited codebase.
2. Agent 004 red team arc is complete through v0.5.0 — further escalation (more agents, more teams, longer campaigns) has diminishing returns. The canonical run found 0 swarm-emergent findings and both audits surfaced no critical or high issues. Next red-team work would require AgentGate to add reputation-gated features to exploit.
3. Consider Agent 005 article — Recursive Code Reviewer. Reuse Agent 004's sandbox architecture in a constructive context.
4. Future: use OpenClaw's documented vulnerability catalog as attack scenarios for Agent 004's recursive red team. The harness exists — the future work is feeding OpenClaw's vulnerability classes into the reasoner/generator pipeline as hypothesis seeds.

---

## AI Workflow & Model Strategy

As of 2026-03-03, AgentGate includes in-repo AI workflow rules:

- `AGENTS.md` (root) — model-agnostic working agreement
- `.claude/rules/` — workflow, security, verification, and code-style constraints

These files make the project tool-agnostic.

AgentGate can now be developed using:
- Claude Code
- ChatGPT (Codex-style workflow)
- Codex CLI — validated as an audit tool. First run caught two broken test setups (TTL_TOO_LONG and PAYLOAD_TOO_LARGE using createApp() instead of buildApp()), fixed in commit 6b6a70f. All 94 tests pass.
- Gemini
- Any future LLM

The rules enforce:
- Small diffs
- Mandatory verification before commit
- Security-first posture (nonce, replay, auth)
- Explicit README updates after architectural changes

If one AI tool is unavailable, development should continue using another without changing process discipline.

---

## Important Notes for Future Claude Sessions

- James has zero prior coding experience and directs AI agents to write all code
- Always take baby steps and explain terminal commands simply — always specify what folder to be in before giving a terminal command
- The project folder is at ~/Desktop/projects/agentgate
- Claude Code is the primary coding tool — James pastes instructions into Claude Code
- Claude Code edits files locally — James must run git push separately to update GitHub
- The GitHub repo name is "agentgate" under the "selfradiance" account — remote uses SSH: git@github.com:selfradiance/agentgate.git
- agent-identity*.json files contain private keys — the wildcard .gitignore pattern covers all of them; never commit any of these files
- Use npm run restart (not just npm run dev) to avoid ghost server processes on port 3000
- James also keeps ChatGPT and Gemini updated with the latest markdown file as backup collaborators
- All projects now live under ~/Desktop/projects/ — never reference ~/Desktop/<project> directly
- At the end of every session, always update both AGENTGATE_PROJECT_CONTEXT.md (add new milestones) and README.md (reflect any architectural or feature changes) before the final commit
