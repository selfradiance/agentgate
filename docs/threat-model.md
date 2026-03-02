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
- Requests older than 60 seconds are rejected.
- The signature covers the timestamp + request body, so modifying either invalidates the signature.

**Known gap:** There is no nonce store. Within the 60-second window, a replayed request with an identical timestamp and body would pass verification. A nonce-based deduplication layer is a future improvement.

### 3. Forged or Tampered Requests

**The problem:** An attacker crafts a request that appears to come from a legitimate agent identity, or modifies a request in transit.

**How AgentGate resists this:**

- All state-changing endpoints require an Ed25519 signature.
- The signed message is: `sha256(timestamp + JSON.stringify(body))`.
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
- If resolved as malicious: the bond's `amount_cents` is reduced (clamped at zero), `slashed_cents` is increased, and the bond is burned.
- The reputation system penalizes malicious actions heavily: -20 points per malicious resolution vs. +10 for success.
- An agent's reputation score follows its identity permanently — there is no way to "reset" a damaged score except by building a long track record of good behavior.

---

## Explicit Non-Goals (What AgentGate Does NOT Protect Against)

Being honest about limitations is as important as describing defenses. AgentGate does not currently address:

### Bond Expiry Enforcement

Bonds have a `ttl_seconds` field, but expiry is only checked when an action tries to use the bond. There is no background process that automatically expires or releases bonds when their TTL elapses. An expired bond sits in "active" status until something touches it.

**Impact:** Low risk in current single-user local deployment. Higher risk in multi-agent or multi-tenant scenarios.

### Auto-Slash on Timeout

If an action is executed but never resolved (the agent crashes, disconnects, or simply ignores the resolution step), the action stays open indefinitely. There is no sweeper process that detects timed-out actions and automatically slashes the bond.

**Impact:** This is the biggest gap in the economic model. An agent can tie up bond capacity forever by executing actions and never resolving them. This is the highest-priority planned fix.

### Multi-Instance / Distributed Deployment

AgentGate uses SQLite with in-memory assumptions. Running multiple Node.js processes against the same database will produce race conditions and incorrect exposure tracking. This is a single-instance system.

**Impact:** Fine for local development and single-server deployment. Not suitable for distributed or high-availability setups without architectural changes.

### Identity Revocation

There is currently no mechanism to revoke or ban an identity. A malicious identity with a slashed reputation can still create new bonds and attempt actions (as long as it has the collateral). The progressive minimum bond and reputation score make this increasingly expensive, but there is no hard ban.

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
| Replay attacks | Timestamp validation (60-second window) + signed requests | ✅ Implemented (no nonce store) |
| Forged requests | Ed25519 signature verification | ✅ Implemented |
| Outbound SSRF | HTTP allowlist + protocol/timeout/size limits | ✅ Implemented |
| Malicious actions | Bond slashing + reputation penalty | ✅ Implemented |
| Unresolved action timeout | Background sweeper + auto-slash | ✅ Implemented — via `sweepExpiredActions()` in service.ts — runs every 60 seconds, slashes bonds whose TTL has expired with unresolved actions |
| Bond auto-expiry | TTL enforcement via background process | ✅ Implemented — via `sweepExpiredActions()` in service.ts — runs every 60 seconds, slashes bonds whose TTL has expired with unresolved actions |
| Identity revocation | Ban list or revocation mechanism | 📋 Future |
| Sybil / identity farming | Proof-of-stake or external identity binding | 📋 Future |
| Real economic collateral | Payment system integration | 📋 Future |
| Multi-instance deployment | Distributed database or coordination layer | 📋 Future |
| Network-level attacks | Reverse proxy / infrastructure concern | ↗️ Out of scope |

---

## Assumptions

1. **The AgentGate server is trusted infrastructure.** The operator (you) controls the server. AgentGate does not protect against a compromised server.
2. **Private keys are kept private.** If an agent's Ed25519 private key is leaked, an attacker can impersonate that identity. Key management is the agent operator's responsibility.
3. **Resolution is honest.** The entity calling `resolve` (marking an action as success/failed/malicious) is trusted to judge correctly. AgentGate enforces the economic consequences of that judgment but does not independently verify whether an action was actually malicious.
4. **Single-instance deployment.** All exposure tracking, rate limiting, and bond accounting assume a single Node.js process with one SQLite database.
5. **Local or trusted network.** The server binds to localhost by default and does not implement TLS. Production deployment requires a reverse proxy for encryption and access control.
