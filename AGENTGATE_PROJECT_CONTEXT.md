# AgentGate — Project Context for Claude

**Last updated:** 2026-03-03 (Session 8)
**Owner:** James Toole
**Repo:** https://github.com/selfradiance/agentgate
**Local folder:** ~/Desktop/agentgate
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
| src/mcp/server.ts | MCP server — exposes 5 tools; has createMcpServer(adapter) factory for testability |
| src/mcp/http-server.ts | MCP Streamable HTTP transport — Express server on port 3001, session management, serves same 5 tools over HTTP |
| src/agent-adapter.ts | Clean agent-facing interface, hides crypto signing and nonce generation; accepts optional identityPath or agentName — named agents get their own agent-identity-{name}.json file |
| src/app.ts | Fastify route handlers (REST API); enforces x-nonce header on all POST routes, records nonces for duplicate detection; exposes sweepExpiredActions() and getDashboardData() for index.ts |
| src/dashboard.ts | Real-time HTML dashboard — shows summary bar, reputation scores, bonds, actions, identities with color-coded statuses, truncated IDs, auto-refresh every 5 seconds |
| src/service.ts | Core logic — bond locking, action execution, resolution, slashing, expired action sweeping, nonce TTL cleanup |
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
| test/mcp-integration.test.ts | End-to-end MCP integration test (all 5 tools) |
| test/sweeper.test.ts | Sweeper tests for expired action auto-slashing |
| docs/threat-model.md | Threat model — attacks, defenses, non-goals, assumptions |
| docs/roadmap/day1-integration-surface.md | Integration surface design doc |
| AGENTS.md | Conventions for AI coding agents |

---

## MCP Tools (5 tools exposed to Claude Desktop)

1. **create_identity** — Creates or loads an Ed25519 identity (auto-called by other tools)
2. **lock_bond** — Locks a bond (stake) for an identity. Inputs: amount_cents, ttl_seconds, reason
3. **execute_bonded_action** — Executes an action through the gate. Inputs: bondId, actionType, payload, exposure_cents
4. **resolve_action** — Resolves an action as success/failed/malicious. Inputs: actionId, outcome
5. **get_reputation** — Gets identity reputation score. Inputs: identityId

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
- All POST endpoints require an x-nonce header (400 error if missing)
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

### Safety Rails
- Rate limiting: 10 executes per 60 seconds per identity
- Progressive minimum bond: higher bond required as action volume increases
- Replay protection via nonce store (duplicate nonce rejection per identity)
- Outbound HTTP: allowlist enforcement, timeout, max request/response size
- Ed25519 signature verification on all state-changing requests
- Auto-slash on expired bonds (sweeper)

### Reputation Scoring
- Formula: locks×2 + actions×3 + successes×10 - failures×5 - malicious×20

---

## Dashboard

- **URL:** http://127.0.0.1:3000/dashboard (server must be running)
- **Summary bar:** identity count, bond count, active bonds, action count
- **Reputation Scores table:** per-identity score with color coding (green positive, red negative, gray zero)
- **Bonds table:** all bonds with truncated IDs, color-coded status, hover for full values
- **Actions table:** all actions with truncated payloads, color-coded status
- **Identities table:** all identities with truncated public keys
- **Auto-refresh:** page reloads every 5 seconds

---

## How to Run

### Start the AgentGate server:
cd ~/Desktop/agentgate
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

**Option A — HTTP transport via mcp-remote (recommended):**
{
  "mcpServers": {
    "agentgate": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:3001/mcp"]
    }
  }
}

**Option B — stdio transport (local only):**
{
  "mcpServers": {
    "agentgate": {
      "command": "/Users/jamestoole/Desktop/agentgate/node_modules/.bin/tsx",
      "args": ["/Users/jamestoole/Desktop/agentgate/src/mcp/server.ts"]
    }
  }
}

To run a named agent with stdio (e.g. "trader"), add an env field:

{
  "mcpServers": {
    "agentgate-trader": {
      "command": "/Users/jamestoole/Desktop/agentgate/node_modules/.bin/tsx",
      "args": ["/Users/jamestoole/Desktop/agentgate/src/mcp/server.ts"],
      "env": { "AGENTGATE_AGENT_NAME": "trader" }
    }
  }
}

The AgentGate HTTP server (npm run restart) MUST be running for MCP tools to work.

### Remote Server (DigitalOcean):
- **Server IP:** 174.138.63.42
- **Provider:** DigitalOcean, Ubuntu 24.04, $4/month droplet
- **To connect:** ssh root@174.138.63.42
- **To start:** cd agentgate && pm2 restart agentgate (or pm2 start npx --name agentgate -- tsx src/index.ts if not yet saved)
- **Dashboard:** http://174.138.63.42:3000/dashboard
- **MCP endpoint:** http://174.138.63.42:3001/mcp
- Both servers bind to 0.0.0.0 for remote access
- ✅ UFW firewall enabled — only ports 22 (SSH), 3000 (dashboard), 3001 (MCP) are open
- ✅ Auth in place on both ports (x-agentgate-key on MCP, x-agentgate-key + Basic Auth on REST/dashboard)
- ⚠️ No TLS — traffic is unencrypted
- **Process manager:** pm2 keeps the server running in the background, auto-restarts on crash, auto-starts on reboot
- **Useful pm2 commands:** pm2 status, pm2 logs agentgate, pm2 restart agentgate, pm2 stop agentgate

### Run tests:
npm run test

All 21 tests should pass.

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

---

## Known Issues / Tech Debt

- **Single-instance only** — SQLite + in-memory assumptions break under multiple Node processes
- **No identity revocation** — malicious identities can't be banned, only economically penalized (documented in threat model)
- **Ghost server processes** — old tsx processes can linger on port 3000; use npm run restart to avoid this
- **No TLS** — both ports (3000 and 3001) are HTTP only. Auth is now in place on both ports, but traffic is unencrypted.

---

## Next Steps (in priority order)

1. **TLS via Caddy or Nginx + Let's Encrypt** — HTTPS for both ports so traffic is encrypted

---
---

## AI Workflow & Model Strategy (New)

As of 2026-03-03, AgentGate includes in-repo AI workflow rules:

- `AGENTS.md` (root) — model-agnostic working agreement
- `.claude/rules/` — workflow, security, verification, and code-style constraints

These files make the project tool-agnostic.

AgentGate can now be developed using:
- Claude Code
- ChatGPT (Codex-style workflow)
- Gemini
- Any future LLM

The rules enforce:
- Small diffs
- Mandatory verification before commit
- Security-first posture (nonce, replay, auth)
- Explicit README updates after architectural changes

If one AI tool is unavailable, development should continue using another without changing process discipline.

## Important Notes for Future Claude Sessions

- James has zero prior coding experience and directs AI agents to write all code
- Always take baby steps and explain terminal commands simply
- The project folder is at ~/Desktop/agentgate
- Claude Code is the primary coding tool — James pastes instructions into Claude Code
- Claude Code edits files locally — James must run git push separately to update GitHub
- The GitHub repo name is "agentgate" under the "selfradiance" account
- agent-identity*.json files contain private keys — the wildcard .gitignore pattern covers all of them; never commit any of these files
- Use npm run restart (not just npm run dev) to avoid ghost server processes on port 3000
- James also keeps ChatGPT updated with the latest markdown file as a backup collaborator
