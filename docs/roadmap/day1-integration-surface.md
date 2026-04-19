# AgentGate → Agent-Integrated Economic Middleware
## Day 1 Design Doc (Integration Surface)

Date: 2026-02-28 (Honolulu)

Purpose: Define the minimal *agent-facing* interface for AgentGate so it can be wrapped as tools (later MCP) without changing the core protocol.

This doc does **not** change existing server behavior. It standardizes:
- the 3 core operations agents need
- inputs/outputs
- error semantics
- the simplest “happy path” workflow

AgentGate already provides:
- Ed25519 identities + signed requests :contentReference[oaicite:0]{index=0}
- reusable bond capacity (reserve/release) :contentReference[oaicite:1]{index=1}
- outbound HTTP safety rails for `market.http` :contentReference[oaicite:2]{index=2}

---

## 0) Definitions (Agent-Facing)

### Identity
A public key (Ed25519) that signs all state-changing requests.

### Bond
A reusable “risk budget” envelope with:
- `amount_cents`
- `outstanding_exposure_cents`
- `slashed_cents`
- `ttl_seconds`
- `status`

Bond capacity rule (effective exposure):
- `effective = ceil(exposure_cents * multiplier)`
- require `outstanding + effective <= amount`

Multiplier default is 1.2. :contentReference[oaicite:3]{index=3}

### Action
A requested operation with declared exposure, tracked until resolved.

Statuses:
- `open` → `success | failed | malicious`

Resolution releases capacity (and may slash if malicious). :contentReference[oaicite:4]{index=4}

---

## 1) Minimal Agent Tool Operations (3)

### Operation A — lock_bond
**Goal:** Ensure the agent has enough bonded capacity to attempt an action.

Agent-Facing Inputs:
- `amount_cents` (int)
- `ttl_seconds` (int)
- `reason` (string, optional)

Server Endpoint (existing):
- `POST /v1/bonds/lock` :contentReference[oaicite:5]{index=5}

Agent-Facing Output:
- `bond_id` (string)
- `amount_cents`
- `outstanding_exposure_cents`
- `expires_at`
- `status`

Notes:
- Bonds are reusable; a single bond can cover multiple concurrent actions until capacity is exhausted. :contentReference[oaicite:6]{index=6}


### Operation B — execute_bonded_action
**Goal:** Execute an action through the gate, reserving exposure from a bond.

Agent-Facing Inputs:
- `bond_id` (string)
- `action_type` (string)  
  - example: `market.http` :contentReference[oaicite:7]{index=7}
- `payload` (object)
- `exposure_cents` (int)

Server Endpoint (existing):
- `POST /v1/actions/execute` (signed) :contentReference[oaicite:8]{index=8}

Agent-Facing Output:
- `action_id` (string)
- `status` (should be `open` on accept)
- `reserved_exposure_cents` (int; effective exposure after multiplier)
- `result` (object; optional debug/audit result)

Notes:
- On accept: capacity is reserved immediately (`outstanding_exposure_cents` increases). :contentReference[oaicite:9]{index=9}
- For `market.http`, outbound rails apply (allowlist, timeout, size limits, etc.). :contentReference[oaicite:10]{index=10} :contentReference[oaicite:11]{index=11}


### Operation C — resolve_action
**Goal:** Finalize action outcome and release capacity. If malicious, slash.

Agent-Facing Inputs:
- `action_id` (string)
- `outcome` (enum: `success | failed | malicious`)
- `details` (object, optional)

Server Endpoint (existing):
- `POST /v1/actions/:actionId/resolve` :contentReference[oaicite:12]{index=12}

Agent-Facing Output:
- `action_id`
- `status` (final status)
- `bond_id`
- `released_exposure_cents` (int)
- `slashed_cents_delta` (int; 0 unless malicious)

Notes:
- Resolve frees capacity (decrements outstanding exposure). :contentReference[oaicite:13]{index=13}
- If `malicious`, bond amount is reduced (clamped at >=0), and slashed_cents increases. :contentReference[oaicite:14]{index=14}

---

## 2) Signing & Auth (What the Agent Wrapper Must Hide)

All state-changing calls require signed headers: :contentReference[oaicite:15]{index=15}
- `x-agentgate-timestamp`
- `x-agentgate-signature`
- `x-nonce`

Signed message:
- `sha256(nonce + method + path + timestamp + JSON.stringify(body))`

This is too low-level for “agent tool” usage.
**The adapter layer (Day 2) must generate signatures, timestamps, and nonces automatically.**

---

## 3) Canonical Happy Path (Single Action)

1) Create/obtain identity (once)
- `POST /v1/identities` :contentReference[oaicite:16]{index=16}

2) lock_bond
- if no active bond or insufficient capacity, lock a bond

3) execute_bonded_action
- declare `exposure_cents`
- action accepted → `action_id`

4) resolve_action
- `success` if downstream succeeded
- `failed` if non-malicious failure
- `malicious` if policy violation / unsafe behavior / wrong intent outcome

---

## 4) Minimal Error Semantics (Agent-Facing)

These error codes should be treated as “first-class” by agent tooling:

### AUTH / SIGNING
- `INVALID_SIGNATURE`
- `MISSING_NONCE`

### BOND / CAPACITY
- `INSUFFICIENT_BOND_CAPACITY` :contentReference[oaicite:17]{index=17}
- `BOND_EXPIRED` / `BOND_NOT_ACTIVE`

### OUTBOUND SAFETY (for market.http)
- `DESTINATION_BLOCKED` :contentReference[oaicite:18]{index=18}
  - includes cases: host not allowlisted, payload too large, timeout, invalid protocol, response too large

### ACTION STATE
- `ACTION_NOT_FOUND`
- `ACTION_ALREADY_RESOLVED`

Agent policy recommendation:
- If `INSUFFICIENT_BOND_CAPACITY`: lock more bond or reduce exposure.
- If `DESTINATION_BLOCKED`: do not retry unless payload/host changed.
- If auth error: regenerate signature with fresh timestamp.

---

## 5) Day 1 Acceptance Criteria

Day 1 is “done” when:

- This doc exists in-repo as `docs/roadmap/day1-integration-surface.md`
- The three operations are clearly defined (inputs/outputs/errors)
- We have one canonical happy path + error policy notes

No code changes required on Day 1.

---

## 6) Next Baby Step (Day 1 → Day 2)

Implement `src/agent-adapter.ts` that exposes:

- `lockBond(...)`
- `executeBondedAction(...)`
- `resolveAction(...)`

and hides:
- signing
- timestamps
- endpoint details
- common error shapingx
