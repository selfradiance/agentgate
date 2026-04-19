# AgentGate Threat Model

> **Version:** 0.1 — March 2026
> **Status:** Living document. Updated as defenses are added.

---

## What AgentGate Protects Against

AgentGate is a **collateralized execution gate** for AI agents. It sits between an autonomous agent and any high-impact external action (API calls, market orders, financial operations) and requires the agent to put up economic collateral before acting.

The core security claim is: **an agent cannot execute costly actions without first posting a bond that can be slashed if the action is judged malicious.** This makes bad behavior economically irrational — the agent loses more than it gains.

This is different from traditional API security (auth tokens, rate limits, policy engines) because those tools answer "is this caller allowed?" AgentGate answers a different question: **"is this caller willing to put money at risk to prove they mean it?"**

Rate limits cap volume. Auth gates cap access. AgentGate caps economic exposure.

---

## Attacker Goals AgentGate Is Designed to Resist

### 1. Synthetic Pressure (Spam/Flooding)

**The problem:** AI agents can generate API calls, bids, negotiations, and form submissions at near-zero marginal cost. Systems designed for human-speed interaction (marketplaces, booking systems, bidding platforms) collapse under synthetic pressure from autonomous agents.

**How AgentGate resists this:**

- Every action requires a bond. An agent flooding a system with 1,000 fake bids needs 1,000× the collateral.
- Progressive minimum bond: after 10 actions in 10 minutes, the required bond jumps to 2,000 cents. After 20, it jumps to 5,000 cents. Sustained spam gets exponentially more expensive.
- Per-identity rate limiting: hard cap of 10 executes per 60 seconds per identity.
- Creating new identities doesn't help — each new identity still needs fresh collateral.

### 2. Replay Attacks

**The problem:** An attacker intercepts a valid signed request and re-sends it to trigger the same action twice (e.g., double-executing a trade).

**How AgentGate resists this:**

- All state-changing requests include a millisecond timestamp in the `x-agentgate-timestamp` header.
- All state-changing requests also require an `x-nonce` header, and nonces are stored per identity and rejected on reuse.
- Requests older than 60 seconds are rejected.
- The signature covers `nonce + method + path + timestamp + JSON.stringify(body)`, so tampering with any signed field invalidates the request.

### 3. Forged or Tampered Requests

**The problem:** An attacker crafts a request that appears to come from a legitimate agent identity, or modifies a request in transit.

**How AgentGate resists this:**

- All state-changing endpoints require an Ed25519 signature.
- Identity registration itself requires proof-of-possession: the caller must sign the registration request with the private key matching the public key being registered.
- Public keys are unique at the database level, so the same key cannot register multiple identities.
- The signed message is: `sha256(nonce + method + path + timestamp + JSON.stringify(body))`.
- The signature is verified against the registered public key for that identity.
- Ed25519 is a strong, well-studied cryptographic scheme — forging a signature without the private key is computationally infeasible.

### 4. Outbound SSRF / Exfiltration via Tool Calls

**The problem:** A malicious or confused agent uses a bonded action to make HTTP requests to internal services, cloud metadata endpoints, or arbitrary external targets — using AgentGate as a proxy for server-side request forgery.

**How AgentGate resists this:**

- Outbound HTTP requests go through a safety layer with an allowlist (default: localhost only).
- Only `http://` and `https://` protocols are permitted.
- Timeout enforced (default 2,500ms) — prevents slow-loris or hanging connections.
- Max request body and response body size limits enforced.
- Requests to non-allowlisted destinations return `DESTINATION_BLOCKED`.

### 5. Malicious Agent Behavior (Post-Execution)

**The problem:** An agent posts a bond, executes an action that causes harm, and tries to walk away.

**How AgentGate resists this:**

- Actions must be explicitly resolved (success, failed, or malicious).
- If resolved as malicious: the action's reserved exposure is slashed, the bond's `amount_cents` is reduced (clamped at zero), and `slashed_cents` is increased. Once the last open action settles, the bond closes as `slashed`.
- The reputation system penalizes malicious actions heavily: -20 points per malicious resolution vs. +10 for success.
- An agent's reputation score follows its identity permanently — there is no way to "reset" a damaged score except by building a long track record of good behavior.

---

## Explicit Non-Goals (What AgentGate Does NOT Protect Against)

Being honest about limitations is as important as describing defenses. AgentGate does not currently address:

### Bond Expiry Enforcement

Bonds with open actions are swept every 60 seconds: if the bond TTL has elapsed while an action is still open, AgentGate auto-resolves that action as `malicious`. But idle bonds are not expired by a separate background pass; an unused expired bond is marked `expired` when something tries to use it.

**Impact:** Honest but slightly asymmetric lifecycle behavior. The economic guarantee is enforced for open actions, but unused expired bonds remain lazily marked until touched.

### Auto-Slash on Timeout

AgentGate does auto-slash unresolved actions, but only on bond TTL expiry. There is no separate per-action timeout shorter than the bond's TTL.

**Impact:** Timeout behavior is tied to bond design. A long-lived bond allows a long-lived unresolved action; a short-lived bond forces faster settlement.

### Multi-Instance / Distributed Deployment

AgentGate uses SQLite with in-memory assumptions. Running multiple Node.js processes against the same database will produce race conditions and incorrect exposure tracking. This is a single-instance system.

**Impact:** Fine for local development and single-server deployment. Not suitable for distributed or high-availability setups without architectural changes.

### Real Economic Collateral

Bonds are denominated in cents but are not backed by real money, cryptocurrency, or any external payment system. The collateral is purely internal accounting. AgentGate enforces the *economic logic* of bonding, but does not yet connect to real-world value transfer.

### Sybil Attacks (Identity Farming)

An attacker can create many Ed25519 identities cheaply. Each identity starts with a clean reputation. While each still needs collateral to act, there is no cost to *creating* identities, which means reputation damage can be diluted across throwaway identities.

**Mitigation path:** Future work could tie identity creation to proof-of-stake, external KYC, or social graph verification.

### Network-Level Attacks

AgentGate does not handle TLS termination, DDoS protection, or network-layer security. It assumes it runs behind a reverse proxy or within a trusted network. In the current default configuration, it binds to `127.0.0.1` (localhost only), which is appropriate for local development.

---

## Defense Summary Table

| Attack | Defense | Status |
|---|---|---|
| Synthetic pressure / spam | Bond requirement + progressive minimums + rate limit | ✅ Implemented |
| Replay attacks | Timestamp validation + nonce store + nonce-bound signed requests | ✅ Implemented |
| Forged requests | Ed25519 signature verification + proof-of-possession on identity registration | ✅ Implemented |
| Outbound SSRF | HTTP allowlist + protocol/timeout/size limits | ✅ Implemented |
| Malicious actions | Bond slashing + reputation penalty | ✅ Implemented |
| Unresolved action timeout | Background sweeper + auto-slash | ✅ Implemented — via `sweepExpiredActions()` in service.ts — runs every 60 seconds, slashes bonds whose TTL has expired with unresolved actions |
| Bond auto-expiry | TTL enforcement on use, plus sweeper for expired bonds with open actions | ⚠️ Partial — open actions are swept; idle expired bonds are marked on next use |
| Identity revocation | Manual ban/unban endpoints + auto-ban after 3 malicious resolutions | ✅ Implemented |
| Sybil / identity farming | Proof-of-stake or external identity binding | 📋 Future |
| Real economic collateral | Payment system integration | 📋 Future |
| Multi-instance deployment | Distributed database or coordination layer | 📋 Future |
| Network-level attacks | Reverse proxy / infrastructure concern | ↗️ Out of scope |

---

## Known Limitations

### Identity Creation Is Unique-Per-Key but Still Cheap Across Fresh Keys

The current identity registration endpoint (`POST /v1/identities`) does enforce proof-of-possession and public-key uniqueness: the caller must sign the registration request with the matching private key, and the same public key cannot be registered twice.

This means:

- **A single actor can still create multiple identities** by generating fresh keypairs they control.
- **Reputation tracking is diluted.** A bad actor with a -40 reputation score can create a fresh identity and start over at 0.
- **Per-identity rate limits (10 actions/60s) can be circumvented** by rotating across identities.
- **The 3-malicious-actions auto-ban threshold resets** with each new identity, so an attacker is never permanently banned — only temporarily inconvenienced.

**This is a known design choice for the current prototype scope.** Economic accountability in AgentGate comes from the bond requirement, not from identity scarcity. Every action — regardless of which identity executes it — still requires real collateral that can be slashed. Creating 10 identities to evade a rate limit means posting 10× the bonds. The progressive minimum bond escalation further increases the cost of sustained abuse.

**Future hardening options:**

1. **External identity binding** — tie keys to proof-of-stake, KYC, or other scarce credentials.
2. **Cross-key reputation linkages** — add stronger operator-side heuristics or attestations for related identities when the deployment warrants it.

### GET Endpoints Do Not Require Authentication

The following GET endpoints are publicly accessible without any API key or signature:

- **`/health`** — returns `{ status: "ok", timestamp }`.
- **`/v1/stats`** — returns aggregate counts (total identities, actions, active bonds, locked cents).
- **`/v1/identities/:id`** — returns identity metadata, public key, and reputation score/stats.

**This is intentional.** `/health` is designed to be unauthenticated so external uptime monitors (e.g., UptimeRobot) can poll it without credentials. The other two endpoints expose only summary data — identity metadata, aggregate statistics, and reputation scores. No private keys, bond amounts tied to specific agents, or action payloads are returned.

**If the deployment scope expands** to include sensitive per-identity data in GET responses (e.g., detailed action history, bond balances, or internal metadata), these endpoints should be gated behind `AGENTGATE_REST_KEY` or Ed25519 signature verification to prevent information leakage.

### Actions Table as Post-Incident Audit Trail

Beyond real-time enforcement, the `actions` table records every bonded action with identity, timestamp, parameters, and outcome. This creates a durable audit trail that can support **post-incident disclosure to affected parties** — not only real-time slashing. Most agent accountability failures involve two problems at once: no economic consequence *and* no record of what happened. AgentGate addresses both. Even when slashing is unavailable or contested, the record remains available for review, notification, and remediation.

---

## Assumptions

1. **The AgentGate server is trusted infrastructure.** The operator (you) controls the server. AgentGate does not protect against a compromised server.
2. **Private keys are kept private.** If an agent's Ed25519 private key is leaked, an attacker can impersonate that identity. Key management is the agent operator's responsibility.
3. **Resolution is honest.** The entity calling `resolve` (marking an action as success/failed/malicious) is trusted to judge correctly. AgentGate enforces the economic consequences of that judgment but does not independently verify whether an action was actually malicious.
4. **Single-instance deployment.** All exposure tracking, rate limiting, and bond accounting assume a single Node.js process with one SQLite database.
5. **Local or trusted network.** The server binds to localhost by default and does not implement TLS. Production deployment requires a reverse proxy for encryption and access control.
